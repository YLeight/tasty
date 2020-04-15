/**
 * class representing synchronous conveyor that illustrates the 'middleware' pattern processing
 * @type {SyncConveyor}
 */
module.exports = class SyncConveyor {

  constructor(initialStruct = null) {
    this.ctx = initialStruct || {};
    this.middleware = [];
  }

  run() {
    this.executeMiddleware(this.middleware, ...arguments);
    //this.ctx is modified during every step of conveyor
    return this.ctx;
  }

  use(middleware) {
    this.middleware.push(middleware);
  }

  executeMiddleware(middleware, ...customArgs) {

    function executor(index) {
      if (index === middleware.length) {
        return this.ctx;
      }
      middleware[index].call(this.ctx, ...customArgs, (err) => {
        if (err) {
          throw new Error(`An error occured while executing the processing of middleware at [${index}] of ${middleware.length}: ${err}`);
        }
        executor.call(this, ++index);
      });
    }

    return executor.call(this, 0);
  }
};
