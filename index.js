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

function Roxy(settingsPath) {
  EventEmitter.call(this);
  
  this.settingsPath = settingsPath;
  this.portStatus = {};
  this.proxy = new RoutingHttpProxy(createTargetStream);
  this.proxy.on('error', console.log);
  
  fs.watchFile(settingsPath, {persistent: false}, this.beginSettingsLoad.bind(this));
  this.beginSettingsLoad();
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


console.log('emit is',RedirectorStream.prototype.emit);

function createTargetStream(host, uri) {
  //console.log('Need target stream for ' + host);
  
  host = stripPort(host);
  var stream = this;
  var server = this._server;
  var port = server.port;
  var roxy = server._proxy;
  var status = roxy.portStatus[port];
  var currentInstructions = status && status.options;
  //console.log('currentInstructions=', currentInstructions);
  var hostRoutes = currentInstructions && currentInstructions.hosts;
  //console.log('hostRoutes=', hostRoutes);
 
  var hostRoute = hostRoutes && hostRoutes[host];
  if (!hostRoute) return null;
   
  if (hostRoute.redirect) {
    return new RedirectorStream(hostRoute.redirect + uri);
  }
  
  return net.connect(hostRoute.port, hostRoute.host); 
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
      });
    }
    
    console.log('set port',port,'to',portInstructions[port]);
    roxy.portStatus[port].setOptions(portInstructions[port]);
  });
};

function annotateError(text, baseError) {
  baseError.message = baseError.message 
    ? text + ' ' + baseError.message
    : text;
  return baseError;
}

new Roxy('./sample2.json');