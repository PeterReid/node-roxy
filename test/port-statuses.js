var net = require('net');
var PortStatus = require('../port-status');
var assert = require('assert');
var Seq = require('Seq');
var tls = require('tls');
var fs = require('fs');

var p = new PortStatus(1050);
p.on('stream', function(stream) {
  stream.on('data', function(d) {
    stream.write(d);
  });
});

function expectEchoer(sock) {
  sock.setEncoding('utf8');
  var str = 'ping!';
  sock.write(str);
  var received = '';
  sock.on('data', function(d) {
    received += d;
  });
  setTimeout(function() {
    sock.end();
    assert.equal(received, str);
  }, 100);
}

Seq()
  .seq(function() {
    p.setOptions({secure:false});
    setTimeout(this, 500);
  })
  .seq(function() {
    expectEchoer(net.connect(1050, 'localhost'));
    setTimeout(this, 500);
  })
  .seq(function() {
    p.setOptions({
      secure:true, 
      key: fs.readFileSync('./test-key.pem'),
      cert: fs.readFileSync('./test-cert.pem')
    });
    setTimeout(this, 1500);
  })
  .seq(function() {
    expectEchoer(tls.connect(1050, 'localhost'));
    setTimeout(this, 500);
  })
  .seq(function() {
    // should close the server
    p.setOptions(null);
  });

