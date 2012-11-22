/*
Type: null, 'tcp', 'tls'


      schedule step 2^n      
      -----------------                          
      |               | error                    
      V   step        |         listening        
 -> IDLE ------->  OPENING  ------------------> OPEN 
      ^  !!type                                  | close
      |                                          |
      --------------------------------------------
                        schedule step (0)      
*/

var EventEmitter = require('events').EventEmitter;
var util = require('util');
var net = require('net');
var tls = require('tls');

function PortStatus(port) {
  EventEmitter.call(this);
  this.port = port;
  this.server = null;
  this.options = null; // what sort of thing is 'server'?
  this.goalOptions = null;
}
util.inherits(PortStatus, EventEmitter)

function optionsEqual(o1, o2) {
  try {
    assert.deepEqual(o1, o2);
    return true;
  } catch (e) {
    return false;
  }
}

PortStatus.prototype.setOptions = function(options) {
  this.goalOptions = options;
  this.step();
};

PortStatus.prototype.createServer = function(options) {
  var onConnection = function(conn) {
    console.log('stream!');
    this.emit('stream', conn);
  }.bind(this)
  
  if (options.secure) {
    return tls.createServer(options, onConnection);
  } else {
    return net.createServer(options, onConnection);
  }
};

PortStatus.prototype.step = function() {
  if (optionsEqual(this.options, this.goalOptions)) {
    if (!this.options && !this.goalOptions) {
      this.emit('idle');
    }
    return;
  }

  if (this.server) {
    // Start shutting down what was here
    if (this.listening) {
      this.server.close();
    }
  } else if (this.goalOptions) {
    // Turn something new on
    this.options = this.goalOptions;
    this.listening = false;
    this.server = this.createServer(this.options)
      .on('listening', this.onListening.bind(this))
      .on('error', this.onError.bind(this))
      .on('close', this.onClose.bind(this))
      .on('stream', this.onStream.bind(this))
      .listen(this.port);
  }
};

PortStatus.prototype.onListening = function() {
  console.log('listening on port', this.port);
  this.listening = true;
};

PortStatus.prototype.onClose = function() {
  this.clearServer();
  this.step();
};


PortStatus.prototype.clearServer = function() {
  this.server.removeAllListeners();
  this.server = null;
  this.options = null;
  this.listening = false;
}
PortStatus.prototype.onError = function(err) {
  if (!this.listening) {
    console.log('Error from server as it was starting up')
    this.clearServer();
    setTimeout(this.step.bind(this), 1000);
  } else {
    console.log('Error from server: ', err);
    this.step();
  }
};

PortStatus.prototype.onStream = function(stream) {
  this.emit('stream', stream);
  console.log('got a stream for PortStatus', this.port)
};

exports = module.exports = PortStatus;
