#!/usr/bin/env node

var request = require('request-promise');
var _ = require('lodash');
var nodemailer = require('nodemailer');
var fs = require('fs');

var cfg = require('./config.json');
var cmd = require('commander');
var provider;

cmd
	.option('-p, --provider [type]', 'Server provider to run alerts for', 'kimsufi')
	.option('-f, --force', 'Force a run regardless of last run', false)
	.parse(process.argv);

//set provider
provider = require('./'+cmd.provider+".json");
console.dir(provider);

check();

function check(){
	request({ json: true, uri: provider.api })
		.then(function(data){
			parse(data);
		})
		.catch(function(err){
			console.error(err);
		})
}

function parse(data){
	var results = [];

	switch(cmd.provider){
		case 'kimsufi':
			results = parseKimsufi(data);
			break;
	}

	//save the results
	getJson('./tmp/last-run', function(lastResults){
		if ( !cmd.force && _.isEqual(results, lastResults) ) {
			console.log('This run produced same results as last run.');
			return;
		}

		saveJson('./tmp/last-run', results, function(err){
			if ( err ) {
				console.error('Could not save last run data');
			}

			sendNotifications(results);
		});
	});
}

function parseKimsufi(data){
	var items = data.answer.availability;
	var results = [];

	//loop over all results
	items.forEach(function(item){
		//only check my servers
		cfg.kimsufi.servers.forEach(function(myServer){

			//is this item one of my servers?
			if ( item.reference === provider.serverMap[myServer] ) {
				//only check my zones
				cfg.kimsufi.zones.forEach(function(myZone){
					var zone = _.where(item.zones, { zone: myZone }).shift() || false;
					if ( !zone || zone.availability === 'unavailable' ) {
						return;
					}

					results.push({
						server: {
							code: item.reference,
							name: myServer
						},
						zone: {
							code: myZone,
							location: provider.zoneMap[myZone]
						},
						status: zone.availability
					});
				});
			}
		});
	});

	return results;
}

function sendNotifications(results){
	sendEmail(results);
	sendSms(results);
}

function getMessage(results){
	var text = [];

	results.forEach(function(item){
		text.push('server: ' + item.server.name);
		text.push('code: ' + item.server.code);
		text.push('zone: ' + item.zone.code);
		text.push('location: ' + item.zone.location);
		text.push('status: ' + item.status);
		text.push('\n');
	});

	text.push('Visit kimsufi at http://kimsufi.com');
	text.push('\n');

	return text;
}

function sendEmail(results){
	if ( !results.length || !cfg.email.enabled ) return;

	var user = process.env[cfg.env.smtp.user];
	var pass = process.env[cfg.env.smtp.pass];
	var host = cfg.env.smtp.host;
	var port = cfg.env.smtp.port;

	if ( !user || !pass || !host || !port ) {
		console.error('Please set set `SMTP_USER` and `SMTP_PASS` environment variables.');
		return;
	}

	var transporter = nodemailer.createTransport({
		host: host,
		port: port,
//		service: 'Gmail', //see https://github.com/andris9/nodemailer-wellknown#supported-services
		auth: {
			user: user,
			pass: pass
		}
	});

	var text = getMessage(results);

	var mailOptions = {
		from: cfg.email.from,
		to: cfg.email.to,
		subject: cfg.email.subject,
		text: text.join('\n')
	};

	transporter.sendMail(mailOptions, function(err, data){
		if (err) return console.trace(err);

		console.log('Email sent: ' + data.response);
	});
}

function sendSms(results){
	if ( !results.length || !cfg.sms.enabled ) return;

	var sid = process.env[cfg.env.sms.sid];
	var auth = process.env[cfg.env.sms.auth];

	var client = require('twilio')(sid, auth);
	var text = getMessage(results);

	client.sendMessage({
		to: cfg.sms.to, // Any number Twilio can deliver to
		from: cfg.sms.from, // A number you bought from Twilio and can use for outbound communication
		body: text.join('\n') // body of the SMS message

	}, function(err, data) { //this function is executed when a response is received from Twilio

		if ( err ) return console.trace(err);

		// "responseData" is a JavaScript object containing data received from Twilio.
		// A sample response from sending an SMS message is here (click "JSON" to see how the data appears in JavaScript):
		// http://www.twilio.com/docs/api/rest/sending-sms#example-1

		console.log('SMS sent from: ', data.from); // outputs "+14506667788"
		//console.log(data.body); // outputs "word to your mother."
	});
}

function saveJson(file, data, cb){
	var dir = './tmp';

	if (!fs.exists(dir)){
		fs.mkdir(dir);
	}

	fs.writeFile(file+'.json', JSON.stringify(data), function(err) {
		if (err) {
			console.trace(err);
			return cb(err);
		}

		cb();
	});
}

function getJson(file, cb){
	if (fs.existsSync(file+'.json')) {
		var data = require(file+'.json');

		console.log('Loaded last run from %s', file);
		return cb(data);
	}

	cb();
}
