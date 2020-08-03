module.exports = {
  config: {
    tls: {
      rejectUnauthorized: false,
    },
    http: {
      timeout: 10,
    },
    phases: [{
      duration: 10,
      arrivalRate: 1,
    }],
  },
};
