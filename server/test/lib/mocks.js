// mocks.js
var express = require('express');

var createServer = function() {
	var app = express();

	// Assume we have a user
	var user = function (req, res, next) {
		req.user = {};
		req.user.memberships = [];
		next();
	};
	app.use(user);

	// Basic request stuff
	var request = function (req, res, next) {
		req.params = {};
		next();
	};
	app.use(request);

	// Accept multiple params of middleware as our args
	for (var index in arguments) {
		app.use(arguments[index]);
	}

	app.use(function (req, res) {
		res.sendStatus(200);
	});
	return app;
};

var createEmpty = function() {
	var app = express();

	// Assume we have a user
	var user = function (req, res, next) {
		req.user = {};
		req.user.memberships = [];
		next();
	};
	app.use(user);
	return app;
};


var errors = function () {
	var doNothing = function () {
		// nothing!
	};
	var throwError = function (error) {
		throw error;
	}
	return {
		handle: throwError,
		log: doNothing
	}
}();

module.exports = function () {
	return {
		empty: createEmpty,
		server: createServer,
		errors: errors
	}
}();