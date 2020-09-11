const path = require('path');
const Mocha = require('mocha');
const _ = require('lodash');
const axios = require('axios');
const { promisify } = require('util');
const parallel = promisify(require('async/parallel'));
const concat = promisify(require('async/concat'));
const concatSeries = promisify(require('async/concatSeries'));
const config = require('../../../../config');
const { v4: uuid } = require('uuid');
const FormData = require('form-data');

const utils = require('../../../../libs/utils');

module.exports = {
  get,
  run,
  request,
  case: suite,
  test,
  tests,
  log,
  think,
};

function get(files) {
  const reportDir = Date.now().toString();

  return files.map(file => getMocha(file, reportDir));
}

async function run(tests, isParallel, logStream, eventHandlersMap) {
  try {
    await utils.enhanceNativeLogger('func_log.html', logStream);

    const stats = isParallel
      ? await concat(tests, _.partial(runTest, eventHandlersMap))
      : await concatSeries(tests, _.partial(runTest, eventHandlersMap));

    utils.resetNativeLogger();

    return formatStats(stats, isParallel);
  } catch(err) {
    await Promise.reject(new Error(err));
  }
}

function request(getParams, mock, capture, resource) {
  return {
    getTraceLink: uid => resource.getTraceLink(uid),
    send: async (context = {}, uid) => {
      const params = getParams(context);

      // @todo implement Resource.setResponse
      resource.res = mock
        ? mockRequest(params, mock)
        : await realRequest(params, uid);

      // @todo implement Resource.captureData
      resource.capturedData = utils.captureData(capture, resource.res);

      return resource;
    },
  };
}

async function suite(title, actions, tasty, prepare) {
  const sets = splitActions(actions);

  if (prepare) await tasty.series(...prepare).send();

  Mocha.describe(title, () => {
    if (sets.before.length) {
      Mocha.before(() => tasty.series(...sets.before).send());
    }

    if (sets.beforeEach.length) {
      Mocha.beforeEach(() => tasty.series(...sets.beforeEach).send()); // @todo need-tests
    }

    sets.tests.forEach(test => test(tasty)); // @todo question: Maybe call test in tasty context?

    if (sets.afterEach.length) {
      Mocha.afterEach(() => tasty.series(...sets.afterEach).send()); // @todo need-tests
    }

    if (sets.after.length) {
      Mocha.after(() => tasty.series(...sets.after).send()); // @todo need-tests
    }
  });

  if (prepare) Mocha.run();
}

function test(title, request, assertions, tasty) {
  const uid = uuid();
  const traceLink = request.getTraceLink && request.getTraceLink(uid);

  if (traceLink)
    Mocha.describe(traceLink, () => {
      _MochaTest();
    });
  else
    _MochaTest();

  function _MochaTest() {
    Mocha.it(`${title}`, async () => {
      const resource = await request.send(tasty.context, !!traceLink && uid);

      tasty.context = {
        ...tasty.context,
        ...resource.capturedData,
      };

      Object.keys(assertions).forEach(assertion => {
        resource[assertion](assertions[assertion], tasty.context);
      });
    });
  }
}

function tests(title, tests, request, assertions, isParallel, tasty) {
  tests = typeof tests === 'string' ? tasty.context[tests] : tests;

  if (isParallel) {
    let resources = [];

    tests.forEach(test => {
      const uid = uuid();
      const traceLink = request.getTraceLink(uid);

      if (traceLink)
        test.trace = {
          id: uid,
          link: traceLink,
        };
    });

    Mocha.before(async () => {
      resources = await parallel(tests.map(({ trace, ...test }) => (
        async () => utils.cloneInstance(
          await request.send({
            ...tasty.context,
            test,
          }, !!trace && trace.id)
        )
      )));
    });

    tests.forEach(({ trace, ...test }, i) => {
      const context = {
        ...tasty.context,
        test,
      };

      if (trace)
        Mocha.describe(trace.link, () => {
          _parallelMochaTest();
        });
      else
        _parallelMochaTest();

      function _parallelMochaTest() {
        Mocha.it(utils.evalTpl(title, context), () => {
          Object.keys(assertions).forEach(assertion => {
            const value = typeof assertions[assertion] === 'string'
              ? utils.evalTpl(assertions[assertion], context)
              : assertions[assertion];

            resources[i][assertion](value, context);
          });
        });
      }
    });
  } else {
    tests.forEach((test) => {
      const uid = uuid();
      const link = request.getTraceLink(uid);
      const context = {
        ...tasty.context,
        test,
      };

      if (!_.isNull(link))
        Mocha.describe(request.getTraceLink(uid), () => {
          _seriesMochaTest();
        });
      else
        _seriesMochaTest();

      function _seriesMochaTest() {
        Mocha.it(utils.evalTpl(title, context), async () => {
          const resource = await request.send(context, uid);

          Object.keys(assertions).forEach(assertion => {
            const value = typeof assertions[assertion] === 'string'
              ? utils.evalTpl(assertions[assertion], context)
              : assertions[assertion];

            resource[assertion](value, context);
          });
        });
      }
    });
  }
}

function log() {
  // @todo implement logging tests
}

function think(seconds) {
  // @todo implement pausing tests
}

function getMocha(file, reportDir) {
  resetCache(file);
  const fileName = path.basename(file, '.js');
  const _cfg = require(config.get('func_cfg'));
  const cfg = {
    reporterOptions: {
      reportDir: path.join(_.get(_cfg, 'reporterOptions.reportDir'), reportDir, fileName),
    }
  };

  if (file.includes('prep')) {
    cfg.delay = true;
  }

  const mocha = new Mocha(_.merge({}, _cfg, cfg));

  return mocha.addFile(path.resolve(file));
}

function runTest(eventHandlersMap, test, cb) {
  try {
    const runner = test.run(() => {
      eventHandlersMap.onTestEnd();
      cb(null, runner.stats);
    });
  } catch(err) {
    cb(err);
  }
}

function formatStats(stats, isParallel) {
  const res = {
    start: _.get(stats, '[0].start', 0),
    end: isParallel ? null : _.get(stats, `[${stats.length - 1}].end`, 0),
    suites: 0,
    tests: 0,
    passes: 0,
    pending: 0,
    failures: 0,
    duration: 0,
  };

  stats.forEach((stat) => {
    res.suites += _.get(stat, 'suites', 0);
    res.tests += _.get(stat, 'tests', 0);
    res.passes += _.get(stat, 'passes', 0);
    res.pending += _.get(stat, 'pending', 0);
    res.failures += _.get(stat, 'failures');

    if (isParallel) {
      res.end = _.get(stat, 'duration', 0) > res.duration ? _.get(stat, 'end', 0) : res.end;
      res.duration = _.get(stat, 'duration', 0) > res.duration ? _.get(stat, 'duration', 0) : res.duration;
    } else {
      res.duration += _.get(stat, 'duration', 0);
    }
  });

  res.duration += 'ms';

  return res;
}

function mockRequest(params, mock) {
  return {
    data: mock,
  };
}

async function realRequest(params, uid) {
  let data = params.body;
  if (params.formData) {
    data = new FormData();

    Object.keys(params.formData).forEach((key) => {
      data.append(key, params.formData[key]);
    });
  }

  try {
    return await axios({
      method: params.method,
      url: params.url,
      headers: {
        ...(uid ? { ...params.headers, 'x-request-id': uid } : params.headers),
        ...(params.formData ? data.getHeaders() : {}),
      },
      params: params.params,
      data,
    });
  } catch (err) {
    return err.response;
  }
}

/**
 * @function splitActions - Split action on three five groups
 * @param {function[]} actions - Tests actions
 * @returns {object} - Object with actions' groups
 */
function splitActions(actions) {
  return actions.reduce((sets, action) => {
    if (typeof action === 'function' && (action.name === 'test' || action.name === 'tests')) {
      sets.tests.push(action);

      return sets;
    }

    if (sets.tests.length) {
      if (Array.isArray(action)) {
        sets.afterEach.push(action);
      } else {
        sets.after.push(action);
      }

      return sets;
    }

    if (Array.isArray(action)) {
      sets.beforeEach.push(action);
    } else {
      sets.before.push(action);
    }

    return sets;
  }, {
    before: [],
    beforeEach: [],
    after: [],
    afterEach: [],
    tests: [],
  });
}

function resetCache(testModule) {
  if (require.cache[path.resolve(testModule)]) {
    delete require.cache[path.resolve(testModule)];
  }
}
