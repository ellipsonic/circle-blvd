var nano = require('nano');
var views = require('./views.js');
var encrypt = require('./encrypt.js');

var couch = function() {
	var databaseUrl = 'http://localhost:5984';
	// TODO: Ideally, we want to make the database automatically
	// if 'burndown' doesn't already exist on first run, and if
	// it does then ask for a new database name. For now, we're
	// letting future selves figure that out.
	var databaseName = 'burndown';

	// Connect to Couch! 
	var database, nanoMaster;
	var databaseOptions = {};
	databaseOptions.url = databaseUrl;
	var nanoMaster = nano(databaseOptions);
	var database = nanoMaster.use(databaseName);

	var databaseExists = function (callback) {
		var opts = {
			db: databaseName,
			method: "GET"
		};

		nanoMaster.relax(opts, function (err, body) {
			if (err && err['status-code'] === 404) {
				callback(null, false);
			}
			else if (err) {
				callback(err);
			}
			else {
				callback(null, true);
			}
		});
	};

	var createDatabase = function (callback) {
		var opts = {
			db: databaseName,
			method: "PUT"
		};

		nanoMaster.relax(opts, callback);
	};

	var createDatabaseAndViews = function(callback) {
		// Create database!
		databaseExists(function (err, exists) {
			if (err) {
				throw (err);
			}
			else if (exists) {
				views.create(database, callback);
			}
			else {
				createDatabase(function (err) {
					if (err) {
						console.log(err);
						callback(err);
					}
					else {
						views.create(database, callback);		
					}
				});
			}
		});
	};

	// getView(viewUrl, [options], callback)
	var getView = function(viewUrl, viewGenerationOptions, callback) {
		var splitViewUrl = viewUrl.split('/');
		var designName = splitViewUrl[0];
		var viewName = splitViewUrl[1];

		if (typeof viewGenerationOptions === "function") {
			callback = viewGenerationOptions;
			viewGenerationOptions = {};
		}

		database.view(designName, viewName, viewGenerationOptions, function (err, body, headers) {
			if (err) {
				callback(err);
				return;
			}
			
			var docs = [];
			body.rows.forEach(function (doc) {
				docs.push(doc.value);
			});

			callback(null, docs);
		});
	};

	var findOneByKey = function(viewName, key, callback) {
		var options = {
			limit: 1,
			key: key
		};
		getView(viewName, options, function (err, rows) {
			var doc = null;
			if (err) {
				callback(err);
			}
			else if (rows && rows.length > 0) {
				doc = rows[0];
			}
			callback(null, doc);
		});		
	}

	var findUserByEmail = function(email, callback) {
		findOneByKey("users/byEmail", email, callback);
	};

	var findUserById = function(id, callback) {
		findOneByKey("users/byId", id, callback);
	};

	var findPasswordById = function (id, callback) {
		findOneByKey("passwords/byId", id, callback);
	};

	var addUser = function(user, password, callback) {
		user.type = "user";
		database.insert(user, function (err) {
			if (err) {
				return callback(err);
			}
			var salt = encrypt.salt();
			var hash = encrypt.hash(password, salt);
			var pass = {
				"userId": user.id,
				"hash":hash, 
				"salt":salt,
				"type": "password"
			}
			database.insert(pass, callback);
		});
	};

	var updateUser = function(user, callback) {
		// TODO: ... document conflicts, etc.
		database.insert(user, callback);
	};

	var getAllUsers = function(callback) {
		getView("users/byId", function (err, rows) {
			callback(err, rows);
		});
	};

	// TODO: Note, this causes the database to be
	// created immediately, which we might not want
	// to necessarily do.
	createDatabaseAndViews(function (err) {
		if (err) {
			console.log(err);
		}
		else {
			// database ready.	
		}
	});

	return {
		users: {
			add: addUser,
			findByEmail: findUserByEmail,
			findById: findUserById,
			getAll: getAllUsers,
			update: updateUser
		},
		passwords: {
			findById: findPasswordById
		}
	}
}();

module.exports = function () {
	return couch;
}(); // closure