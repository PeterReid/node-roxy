var Stream = require('stream');
var util = require('util');

var RedirectorStream = function(url) {
  Stream.call(this);
  
  process.nextTick(function() {
    this.emit('data', 'HTTP/1.1 301 Moved Permanently\r\nLocation: '+url+'\r\n\r\n');
    this.emit('end')
  }.bind(this));
};
util.inherits(RedirectorStream, Stream);
RedirectorStream.prototype.readable = true;
RedirectorStream.prototype.write = function() {}
RedirectorStream.prototype.end = function() {}
RedirectorStream.prototype.destroy = function() {}
RedirectorStream.prototype.destroySoon = function() {}
RedirectorStream.prototype.pause = function() {}
RedirectorStream.prototype.resume = function() {}
RedirectorStream.prototype.setEncoding = function() {}

exports = module.exports = RedirectorStream;