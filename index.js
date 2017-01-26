var EventEmitter = require('events').EventEmitter;
var fs = require('fs');
var RoutingHttpProxy = require('../node-routing-http-proxy/routing-http-proxy');
var util = require('util');
var net = require('net');
var tls = require('tls');
var Seq = require('seq');
var path = require('path');
var PortStatus = require('./port-status');
var RedirectorStream = require('./redirector-stream');
var http = require('http');
var url = require('url');


var Stream = require('stream');
var StaticStream = function() {
  Stream.call(this);
  
  process.nextTick(function() {
    this.emit('data', 'HTTP/1.1 200 OK\r\n\r\n{"messages": [], "required_documents": [], "factor": 10000}');
    this.emit('end')
  }.bind(this));
};
util.inherits(StaticStream, Stream);
StaticStream.prototype.readable = true;
StaticStream.prototype.write = function() {}
StaticStream.prototype.end = function() {}
StaticStream.prototype.destroy = function() {}
StaticStream.prototype.destroySoon = function() {}
StaticStream.prototype.pause = function() {}
StaticStream.prototype.resume = function() {}
StaticStream.prototype.setEncoding = function() {}



process.on('uncaughtException', function(e) {
  console.log('Uncaught exception:', e);
});

function Roxy(settingsPath, debugPort) {
  EventEmitter.call(this);
  
  this.settingsPath = settingsPath;
  this.portStatus = {};
  this.proxy = new RoutingHttpProxy(createTargetStream);
  this.proxy.on('error', console.log);
  
  fs.watchFile(settingsPath, {persistent: false}, this.beginSettingsLoad.bind(this));
  this.beginSettingsLoad();
  
  if (debugPort) {
    this.startDebugServer(debugPort);
  }
  
  this.recentAccess = new Array(1024);
  this.recentAccessWriteIdx = 0;
};
util.inherits(Roxy, EventEmitter);

Roxy.prototype.beginSettingsLoad = function() {
  fs.readFile(this.settingsPath, 'utf8', this.onReadSettings.bind(this));
}

function stripPort(host) {
  var colon = host.indexOf(':');
  if (colon == -1) return host;
  return host.substring(0, colon);
}


var sourceIPs = {};

function recordSourceIP(host, requestorStream, targetStream) {
  targetStream.once('connect', function() {
    console.log('data', host, requestorStream.remoteAddress, targetStream.localPort, targetStream.remotePort);
    sourceIPs[targetStream.localPort] = requestorStream.remoteAddress;
  });
}

var ipSourceResolver = http.createServer(function(req, res) {
  var port = req.url.substring(1);
  res.end(sourceIPs[port]);
}).listen(10030, 'localhost');


function createTargetStream(host, uri) {
  //console.log('Need target stream for ' + host);
  this._proxiedFor = host;
  
  
  var stream = this;
  var server = this._server;
  var port = server.port;
  var roxy = server._proxy;
  var status = roxy.portStatus[port];
  var currentInstructions = status && status.options;
  //console.log('currentInstructions=', currentInstructions);
  var hostRoutes = currentInstructions && currentInstructions.hosts;
  //console.log('hostRoutes=', hostRoutes);
 
  stream._proxiedFor = host;
 
  var hostRoute = hostRoutes && hostRoutes[host];
  if (!hostRoute) return null;
   
  if (hostRoute.redirect) {
    return new RedirectorStream(hostRoute.redirect + uri);
  }
  if (uri.indexOf('/get_new_messages/')>=0) {
    return new StaticStream();
  }
  
  var stream = net.connect(hostRoute.port, hostRoute.host);
  this.once('proxy', recordSourceIP);
  
  return stream; 
}

Roxy.prototype.onReadSettings = function(err, fileString) {
  if (err) return this.emit('error', annotateError('Failed to read settings file.', err));
  
  
  
  var settings;
  try {
    settings = JSON.parse(fileString);
  } catch(e) {
    return this.emit('error', annotateError('Failed to parse settings JSON.', e));
  }
  
  this.validateSettings(settings, this.onValidatedSettings.bind(this));
};

/**
 * dir: prefix for all paths
 * files: {path -> ?}
 * cb: fn(err, {path -> file contents Buffer})
 */
function readFileSet(dir, needed, cb) {
  var gotten = {};
  Seq(unionKeys(needed, {}))
    .seqEach(function(file) {
      var next = this;
      fs.readFile(path.join(dir, file), function(err, contents) {
        if (err) return next(err);
        gotten[file] = contents;
        next();
      })
    })
    .seq(function() {
      cb(null, gotten);
    })
    .catch(function(err) {
      cb(err);
    });
}

var knownProtocols = {
  'http': {
    secure: false,
    defaultPort: 80
  },
  'https': {
    secure: true,
    defaultPort: 443
  }
};

function parseUri(inputPath) {
  var protoEnd = inputPath.indexOf('://');
  if (protoEnd == -1) throw new Error('Protocol not specified in "' + inputPath + '". Start with protocol://');
  
  var protocol = inputPath.substring(0, protoEnd);
  var protocolInfo = knownProtocols[protocol];
  if (!(protocol in knownProtocols)) throw new Error('Protocol (' + protocol + ') unrecognized in "' + inputPath + '"');
  
  var portStart = inputPath.indexOf(':', protoEnd+3);
  var host = portStart == -1 ? inputPath.substr(protoEnd+3) : inputPath.substring(protoEnd+3, portStart);
  var port = portStart == -1 ? protocolInfo.defaultPort : parseInt(inputPath.substring(portStart+1));
  return {
    secure: protocolInfo.secure,
    port: port,
    host: host
  };
}

function resolveCertAndKey(dest, files) {
  if (dest.cert) dest.cert = files[dest.cert];
  if (dest.key) dest.key = files[dest.key];
}

Roxy.prototype.validateSettings = function(settings, cb) {
  console.log("validating settings");
  var instructionsByPort = {};
  
  var neededFiles = {};
  
  for (var inputPath in settings) {
    var input = parseUri(inputPath);
    var output = settings[inputPath]; // misnamed
    
    console.log(input);
    if (!(input.port in instructionsByPort)) {
      instructionsByPort[input.port] = {
        secure: input.secure,
        hosts: {}
      }
    }
    var instructions = instructionsByPort[input.port];
    if (input.secure != instructions.secure) {
      throw new Error('Port ' + input.port + ' cannot be both secure and insecure!');
    }
    
    if (input.host in instructions.hosts) {
      throw new Error('Host "' + target.host + '" is already specified for port ' + input.port);
    }
    
    instructions.hosts[input.host] = 
      output.redirect ? {redirect: output.redirect} : parseUri(output.target);
    if (input.secure) {
      instructions.hosts[input.host].cert = output.cert;
      instructions.hosts[input.host].key = output.key;
      neededFiles[output.cert] = true;
      neededFiles[output.key] = true;
      
      //if (instructions.cert && output.cert != instructions.cert) {
      //  throw new Error('Conflicting certificates for port ' + input.port);
      //}
      //if (instructions.key && output.key != instructions.key) {
      //  throw new Error('Conflicting keys for port ' + input.port);
      //}
      if (!instructions.cert && !instructions.key) {
        instructions.cert = output.cert;
        instructions.key = output.key;
      }      
    }
  }
  
  console.log(neededFiles);
  
  var dir = path.dirname(this.settingsPath);
  
  readFileSet(dir, neededFiles, function(err, files) {
    if (err) return cb(err);
    
    for (var port in instructionsByPort) {
      var instructions = instructionsByPort[port];
      resolveCertAndKey(instructions, files);
      
      for (var host in instructions.hosts) {
        resolveCertAndKey(instructions.hosts[host], files);
      }
    }
    cb(null, instructionsByPort);
  });
}

function unionKeys(ob1, ob2) {
  var keys = [];
  var key;
  for (key in ob1) {
    keys.push(key);
  }
  for (key in ob2) {
    if (!key in ob1) {
      keys.push(key);
    }
  }
  return keys;
}

Roxy.prototype.onValidatedSettings = function(err, portInstructions) {
  var roxy = this;
  if (err) return this.emit('error', err);
  
  var ports = unionKeys(portInstructions, this.portStatus);
  
  ports.forEach(function(port) {
    if (!(port in roxy.portStatus)) {
      roxy.portStatus[port] = new PortStatus(port);
      roxy.portStatus[port]._proxy = roxy;
      roxy.portStatus[port].on('stream', function(stream) {
        //console.log('handling a stream');
        stream._server = this;
        roxy.proxy.proxy(stream);
        stream.on('data', Roxy.prototype.onData.bind(roxy, stream));
      });
    }
    
    console.log('set port',port,'to',portInstructions[port]);
    roxy.portStatus[port].setOptions(portInstructions[port]);
  });
};


Roxy.prototype.onData = function(stream, data) {
  if (data.length > 5) {
    var c0 = data[0];
    var c1 = data[1];
    var c2 = data[2];
    var c3 = data[3];
    var c4 = data[4];
    if (
      (c0==71 && c1==69 && c2==84 && c3==32)
      ||
      (c0==80 && c1==79 && c2==83 && c3==84)
      ) {
      var c;
      for (var i=0; i<data.length && i < 256 && (c=data[i])>=32 && c<=126; i++) {
        i++;
      }
      
      this.recentAccess[this.recentAccessWriteIdx] = new Date().toISOString() + ' ' + stream._proxiedFor + ' ' + stream.remoteAddress + ' ' + data.slice(0, i).toString();
      this.recentAccessWriteIdx = (this.recentAccessWriteIdx+1) % this.recentAccess.length;
    }
  }
}

Roxy.prototype.startDebugServer = function(port) {
  console.log('starting debug server on port', port)
  http.createServer(this.onDebugRequest.bind(this))
    .listen(port, 'localhost')
    .on('error', function(err) {
      console.log('Error from debug server', err);
    });
}

Roxy.prototype.onDebugRequest = function(req, res) {
  //console.log('arguments')
  
  var param = url.parse(req.url, true);
  if (param.pathname == '/access') {
    var q = param.query['q'] || '';
    var recent = [];
    var idx = this.recentAccessWriteIdx - 1;
    for (var i = 0; i < this.recentAccess.length; i++) {
      if (idx==-1) idx = this.recentAccess.length-1;
      var msg = this.recentAccess[idx];
      if (msg && msg.indexOf(q)>=0) {
        recent.push(msg)
      }
      idx--;
    }
    res.end(recent.join('\n'));
  } else {
    res.end('--')
  }
}




function annotateError(text, baseError) {
  baseError.message = baseError.message 
    ? text + ' ' + baseError.message
    : text;
  return baseError;
}

new Roxy('./sample2.json', 8090);