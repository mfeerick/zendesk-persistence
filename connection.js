var redisLib = require('redis'),
    Tracker = require('callback_tracker'),
    sentinelLib = require('redis-sentinel'),
    logging = require('minilog')('connection');

function redisConnect(config) {
  var client = redisLib.createClient(config.port, config.host);
  if (config.redis_auth) {
    client.auth(config.redis_auth);
  }

  logging.info('Created a new Redis client.');
  return client;
}

function sentinelConnect(config) {
  var client, options,
      redisAuth = config.redis_auth,
      sentinelMaster = config.id,
      sentinels = config.sentinels;

  if(!sentinels || !sentinels.length || !sentinelMaster) {
    throw new Error('Provide a valid sentinel cluster configuration ');
  }

  if(redisAuth) {
    options = { auth_pass: redisAuth };
  }
  client = sentinelLib.createClient(sentinels, sentinelMaster, options);

  logging.info('Created a new Sentinel client.');
  return client;
}

function Connection(name, config) {
  this.name = name;
  this.config = config;
  this.client = null;
  this.subscriber = null;
  this.readyListeners = [];
  this.teardownListeners = [];
}

Connection.prototype.selectMethod = function() {
  var method = redisConnect;
  if(this.config.id || this.config.sentinels) {
    method = sentinelConnect;
  }
  return method;
};

Connection.prototype.establishDone = function() {
  var readyListeners = this.readyListeners;
  this.readyListeners = [];

  readyListeners.forEach(function(listener) {
    if(listener) listener();
  });
};

Connection.prototype.teardownDone = function() {
  var teardownListeners = this.teardownListeners;
  this.teardownListeners = [];

  teardownListeners.forEach(function(listener) {
    if(listener) listener();
  });
};

Connection.prototype.isReady = function() {
  return (this.client && this.client.connected &&
          this.subscriber && this.subscriber.connected);
};

Connection.prototype.establish = function(ready) {
  ready = ready || function() {};
  var self = this;

  this.readyListeners.push(ready);

  if(this.isReady()) {
    return this.establishDone();
  }

  if(this.readyListeners.length == 1) {
    var tracker = Tracker.create('establish :' + this.name , function() {
      self.establishDone();
    });

    var method = this.selectMethod();

    //create a client (read/write)
    this.client = method(this.config);
    logging.info('Created a new client.');
    this.client.once('ready', tracker('client ready :'+ this.name));

    //create a pubsub client
    this.subscriber = method(this.config);
    logging.info('Created a new subscriber.');
    this.subscriber.once('ready', tracker('subscriber ready :'+ this.name));
  }
};

Connection.prototype.teardown = function(callback) {
  var self = this;
  callback = callback || function() {};

  this.teardownListeners.push(callback);

  if(this.teardownListeners.length == 1) {
    var tracker = Tracker.create('teardown: ' + this.name , function() {
      self.teardownDone();
    });

    if(this.client) {
      if(this.client.connected) {
        this.client.quit(tracker('quit client :'+ this.name));
      }
      this.client = null;
    }

    if(this.subscriber) {
      if(this.subscriber.connected) {
        this.subscriber.quit(tracker('quit subscriber :'+ this.name));
      }
      this.subscriber = null;
    }

    tracker('client && subscriber checked')();
  }
};

module.exports = Connection;
