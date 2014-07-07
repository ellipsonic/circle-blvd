var express  = require('express');
var http     = require('http');
var request  = require('request');
var path     = require('path');
var mailer   = require('nodemailer');
var routes   = require('./routes');

var auth     = require('./lib/auth.js');
var ensure   = require('./lib/auth-ensure.js');
var db       = require('./lib/dataAccess.js').instance();

var sslServer = require('./lib/https-server.js');
var payment   = require('./lib/payment.js');
var settings  = require('./lib/settings.js');

var usersRoutes = require('./routes/users');
var userRoutes 	= require('./routes/user');
var initRoutes 	= require('./routes/init');

var couchSessionStore = require('./lib/couch-session-store.js');

var app = express();

var initAuthentication = function () {
	auth.usernameField('email');
	auth.passwordField('password');
	app.use(auth.initialize());
	// Use passport.session() middleware to support
	// persistent login sessions.
	app.use(auth.session());
};

// Error handling.
var logError = function (err) {
	console.log(err);
};

var handleError = function (err, res) {
	var message = err.message || "Internal server error";
	var status = err.status || 500;
	logError(err);
	res.send(status, message);
};

// Authentication. 
var authenticateLocal = function(req, res, next) {
	var success = function() {
		var dbUser = req.user;
		var publicUser = {};

		publicUser.id = dbUser.id;
		publicUser.email = dbUser.email;
		publicUser.name = dbUser.name;
		publicUser.memberships = dbUser.memberships;
		publicUser.notifications = dbUser.notifications;

		res.send(200, publicUser);
	};

	var failure = function(error) {
		logError(error);
		res.send(401, "Unauthorized"); 
	};

	var middleware = auth.local(req, success, failure);
	middleware(req, res, next);
};

var tryToCreateHttpsServer = function (callback) {
	sslServer.create(app, callback);
};

var configureSuccessful = function () {
	app.post('/auth/signin', authenticateLocal);

	app.get('/auth/signout', function (req, res) {
		req.logout();
		// TODO: How to destroy sessions?
		// if (req.session) {
		// 	req.session.destroy();	
		// }
		res.send(204); // no content
	});

	// Data API: Protected by authorization system

	// Users routes (global actions. requires admin access)
	
	// TODO: Mainframe-access only, when the time comes.
	// app.get("/data/users", ensureAdministrator, usersRoutes.list);
	// app.post("/data/user", ensureAdministrator, usersRoutes.add);
	// app.put("/data/user/remove", ensureAdministrator, usersRoutes.remove);
	
	// User routes (account actions. requires login access)
	app.get("/data/user", ensure.auth, userRoutes.user);

	app.put("/data/user/name", ensure.auth, userRoutes.updateName);
	app.put("/data/user/email", ensure.auth, userRoutes.updateEmail);
	app.put("/data/user/notificationEmail", ensure.auth, userRoutes.updateNotificationEmail)

	app.put("/data/user/password", ensure.auth, userRoutes.updatePassword);

	// User routes (circle actions. requires admin access)
	app.get("/data/:circleId/members", ensure.circleAdmin, function (req, res) {
		var circleId = req.params.circleId;
		db.users.findByCircleId(circleId, function (err, users) {
			if (err) {
				return handleError(err, res);
			}
			res.send(200, users);
		});
	});

	app.put("/data/:circleId/member/remove", ensure.circleAdmin, function (req, res) {
		// usersRoutes.remove
		var circleId = req.params.circleId;
		var reqUser = req.body;

		db.users.findById(reqUser.id, function (err, user) {
			if (err) {
				return handleError(err, res);
			}

			var newMemberships = [];
			user.memberships.forEach(function (membership) {
				if (membership.circle === circleId) {
					// do nothing
				}
				else {
					newMemberships.push(membership);
				}
			});

			user.memberships = newMemberships;
			db.users.update(user, function (body) {
				res.send(204);
			},
			function (err) {
				handleError(err, res);
			});
		});
	});

	app.post("/data/:circleId/member", ensure.circleAdmin, function (req, res) {
		var circleId = req.params.circleId;
		var member = req.body;

		// TODO: Get the memberships from the server side.
		// The client should only need to specify user data
		// and the group names.
		var addMembershipsToAccount = function (account) {
			member.memberships.forEach(function (newMembership) {
				// Basic data validation
				if (newMembership.circle === circleId) {
					var m = {};
					m.circle = newMembership.circle;
					m.group = newMembership.group;
					m.level = newMembership.level;
					account.memberships.push(m);
				}
			});

			db.users.update(account, 
				function (body) {
					res.send(201);
				},
				function (err) {
					handleError(err, res);
				}
			);
		};

		db.users.findByEmail(member.email, function (err, userAccount) {
			if (err) {
				return handleError(err, res);
			}

			if (userAccount) {
				addMembershipsToAccount(userAccount);
			}
			else {
				var isReadOnly = false;
				var memberships = [];
				db.users.add(
					member.name,
					member.email, 
					member.password,
					[], // no memberships at first
					member.isReadOnly,
					function (user) {
						addMembershipsToAccount(user);
					}, 
					function (err) {
						handleError(err, res);
					});
			}
		});
	});

	app.get("/data/:circleId/members/names", ensure.circle, function (req, res) {
		var circleId = req.params.circleId;
		db.users.findNamesByCircleId(circleId, function (err, names) {
			if (err) {
				return handleError(err, res);
			}

			var ignoreCase = function (a, b) {
				a = a.toLowerCase();
				b = b.toLowerCase();
				if (a < b) {
					return -1;
				}
				if (a > b) {
					return 1;
				}
				return 0;
			};

			names = names.sort(ignoreCase);
			res.send(200, names);
		});
	});

	// Init routes
	app.put("/data/initialize", initRoutes.init);

	// Settings!
	app.get("/data/settings", function (req, res) { // public
		var onSuccess = function (settings) {
			db.settings.getAuthorized(function (privateSettings) {
				// Computed settings.
				var smtpEnabledSetting = {
					type: "setting",
					name: "smtp-enabled",
					visibility: "public"
				};

				if (privateSettings['smtp-login'] 
					&& privateSettings['smtp-login'].value) {
					smtpEnabledSetting.value = true;
				}
				else {
					smtpEnabledSetting.value = false;
				}

				settings['smtp-enabled'] = smtpEnabledSetting;
				res.send(200, settings);
			},
			function (err) {
				// Ignore
				res.send(200, settings);
			});
		};

		onFailure = function (err) {
			handleError(err, res);
		};

		db.settings.get(onSuccess, onFailure);
	});

	app.get("/data/settings/private", ensure.mainframe, function (req, res) {
		var onSuccess = function (settings) {
			res.send(200, settings);
		};

		onFailure = function (err) {
			handleError(err, res);
		};

		db.settings.getPrivate(onSuccess, onFailure);
	});

	app.get("/data/settings/authorized", ensure.mainframe, function (req, res) {
		var onSuccess = function (settings) {
			res.send(200, settings);
		};

		onFailure = function (err) {
			handleError(err, res);
		};

		db.settings.getAuthorized(onSuccess, onFailure);
	});

	app.put("/data/setting", ensure.mainframe, function (req, res) {
		var data = req.body;
		db.settings.save(data, 
			function (setting) {
				if (setting.name === 'ssl-key-path' || setting.name === 'ssl-cert-path') {
					// TODO: Tell the client if we started the server?
					tryToCreateHttpsServer();
				}
				if (setting.name === 'stripe-secret-key') {
					payment.setApiKey(setting.value);
				}
				res.send(200);
			},
			function (err) {
				handleError(err, res);
			}
		);
	});

	// Circles!
	app.get("/data/circles", ensure.auth, function (req, res) {
		db.circles.findByUser(req.user, function (err, circles) {
			if (err) {
				return handleError(err, res);
			}

			res.send(200, circles);
		});
	});

	app.get("/data/circles/all", ensure.mainframe, function (req, res) {
		db.circles.getAll(function (err, circles) {
			if (err) {
				return handleError(err, res);
			}
			res.send(200, circles);
		})
	});

	var addStoriesForNewCircle = function (newCircle, adminAccount, callback) {
		
		var newStory = function () {
			var story = {};
			story.projectId = newCircle._id;
			return story;
		};

		var welcome = newStory();
		welcome.summary = "Welcome to Circle Blvd.";
		welcome.status = "active";
		welcome.isFirstStory = true;
		welcome.description = "Hi! This is a story list. The main idea is that " +
		"stories closer to the top want to be completed before the ones closer " + 
		"to the bottom.\n\nPlay around with it. Maybe start by moving the 'Next " + 
		"meeting' around.";

		var addStories = newStory();
		addStories.summary = "To get started, add a few stories";
		addStories.owner = adminAccount.name;
		addStories.description = "Please see the 'Add story' link, at the top " +
		"of the story list, to get started.";

		var addTeamMembers = newStory();
		addTeamMembers.summary = "When you're ready, add some team members";
		addTeamMembers.status = "assigned";
		addTeamMembers.description = "You can do this from the Admin page.";

		var seeDocs = newStory();
		seeDocs.summary = "Check out the documentation for more details";

		var readyMilepost = newStory();
		readyMilepost.isDeadline = true;
		readyMilepost.summary = "Start using the site";

		var nextMeeting = newStory();
		nextMeeting.summary = "Next meeting";
		nextMeeting.isNextMeeting = true;

		var subscribe = newStory();
		subscribe.summary = "Subscribe, if you can";
		subscribe.owner = adminAccount.name;
		subscribe.description = "Circle Blvd. may be used for free, for a reasonable " +
		"amount of time. Like Wikipedia, we rely on donations to keep the site online. You " +
		"can subscribe from the profile page, and end your subscription at any time.";

		var haveFun = newStory();
		haveFun.summary = "Have fun :-)";
		haveFun.status = "assigned";
		haveFun.description = "Please enjoy using our site. To send us a note, you can find " + 
		"us on Twitter at @circleblvd. Thank you!";

		var stories = [
			welcome,
			addStories,
			addTeamMembers,
			seeDocs,
			readyMilepost,
			nextMeeting,
			subscribe,
			haveFun
		];
		stories.reverse();

		var currentIndex = 0;

		var addStory = function (story, nextId) {
			if (nextId) {
				story.nextId = nextId;
			}
			db.stories.add(story, function (err, body) {
				if (err) {
					return callback(err);
				}
				currentIndex++;
				if (currentIndex >= stories.length) {
					callback();
				}
				else {
					addStory(stories[currentIndex], body.id);
				}
			});	
		};

		addStory(stories[currentIndex]);
	};

	var createCircle = function (circleName, adminEmailAddress, callback) {
		var circle = {
			name: circleName
		};

		db.users.findByEmail(adminEmailAddress, function (err, adminAccount) {
			if (err) {
				return callback(err);
			}

			circle.createdBy = {
				name: adminAccount.name,
				id: adminAccount._id
			};

			db.circles.add(circle, function (err, newCircle) {
				if (err) {
					return callback(err);
				}

				var administrativeGroup = {
					name: "Administrative",
					projectId: newCircle._id,
					isPermanent: true
				};

				var impliedGroup = {
					name: "_implied",
					projectId: newCircle._id,
					isPermanent: true
				};

				addStoriesForNewCircle(newCircle, adminAccount, function (err, body) {
					if (err) {
						return callback(err);
					}

					db.groups.add(administrativeGroup, function (adminGroup) {
						db.groups.add(impliedGroup, function (memberGroup) {

							var addCircleMembershipsToAdmin = function (account) {
								// admin access
								account.memberships.push({
									circle: newCircle._id,
									group: adminGroup.id,
									level: "member"
								});
								// member access
								account.memberships.push({
									circle: newCircle._id,
									group: memberGroup.id,
									level: "member"
								});

								db.users.update(account, 
									function (body) {
										callback(null, newCircle);
									},
									function (err) {
										callback(err);
									}
								);
							};

							if (adminAccount) {
								addCircleMembershipsToAdmin(adminAccount);
							}
							else {
								var err = {};
								err.message = "Admin account was not found. Cannot create circle " +
								"witout an exiting admin account.";
								callback(err);
							}
						},
						function (err) {
							// failure adding member group
							callback(err);
						});
					},
					function (err) {
						// failure adding admin group
						callback(err);
					});
				});

			})
		});
	};

	app.post("/data/circle", ensure.auth, function (req, res) {
		var circleName = req.body.name;
		var admin = req.user;

		if (!circleName) {
			return res.send(400, "A 'name' property is required, for naming the circle.");
		}

		db.circles.findByUser(req.user, function (err, rawCircles) {
			if (err) {
				return handleError(err, res);
			}

			// TODO: Need to remove dups from the view
			var circles = {};
			rawCircles.forEach(function (circle) {
				circles[circle._id] = circle;
			});

			var circlesCreatedCount = 0;
			for (var key in circles) {
				var circle = circles[key];
				if (circle.createdBy
				&& circle.createdBy.id === req.user._id) {
					circlesCreatedCount++;
				}
			}

			// TODO: Put this hard-coded value into the settings.
			var maxCircleCount = 4;
			if (circlesCreatedCount >= maxCircleCount) {
				return res.send(403, "Sorry, you can only create " + maxCircleCount + " circles.");
			}

			createCircle(circleName, admin.email, function (err, newCircle) {
				if (err) {
					return handleError(err, res);
				}
				res.send(200, newCircle);
			});
		});
	});

	app.post("/data/circle/admin", ensure.mainframe, function (req, res) {
		var circle = req.body.circle;
		var admin = req.body.admin;

		if (!admin.email) {
			return res.send(400, "An email address for an administrative user is required when making a circle.");
		}

		createCircle(circle.name, admin.email, function (err, newCircle) {
			if (err) {
				return handleError(err, res);
			}

			res.send(200, newCircle);
		});
	});

	app.put("/data/circle", ensure.mainframe, function (req, res) {
		var circle = req.body;
		db.circles.update(circle, function (err, updateCircle) {
			if (err) {
				return handleError(err, res);
			}
			res.send(200, updateCircle);
		});
	});


	// Groups!
	app.get("/data/:circleId/groups", ensure.circle, function (req, res) {
		var circleId = req.params.circleId;
		db.groups.findByProjectId(circleId, function (err, groups) {
			if (err) {
				return handleError(err, res);
			}
			
			res.send(200, groups);
		});
	});

	// TODO: We'll turn groups on at a later time, as we
	// transition toward hosting larger groups, but in the 
	// mean time this is just a security hole.
	// 
	// var addGroup = function (group, res) {
	// 	db.groups.add(group, 
	// 		function (group) {
	// 			res.send(200, group);
	// 		},
	// 		function (err) {
	// 			handleError(err, res);
	// 		}
	// 	);
	// };

	// TODO: Ensure circle access
	// app.post("/data/group", ensureAdministrator, function (req, res) {
	// 	var data = req.body;

	// 	var group = {};	
	// 	group.projectId = data.projectId;
	// 	group.name = data.name;

	// 	addGroup(group, res);
	// });

	// // TODO: Ensure circle access
	app.get("/data/group/:groupId", ensure.auth, function (req, res) {
		var groupId = req.params.groupId;
		db.groups.findById(groupId, function (err, group) {
			if (err) {
				return handleError(err, res);
			}
			res.send(200, group);
		});
	});

	// // TODO: Ensure circle access
	// app.put("/data/group/remove", ensureAdministrator, function (req, res) {
	// 	var group = req.body;

	// 	db.groups.remove(group, 
	// 		function () {
	// 			res.send(200);
	// 		},
	// 		function (err) {
	// 			handleError(err, res);
	// 		}
	// 	);
	// });


	// Story routes
	app.get("/data/:circleId/stories", ensure.circle, function (req, res) {
		var circleId = req.params.circleId;

		db.stories.findByProjectId(circleId, function (err, stories) {
			if (err) {
				return handleError(err, res);
			}
			res.send(200, stories);
		});
	});

	// TODO: combine this with /stories to return one object with 
	// both the story list and the first story (in two different things)
	app.get("/data/:circleId/first-story", ensure.circle, function (req, res) {
		var circleId = req.params.circleId;
		db.stories.getFirstByProjectId(circleId, function (err, firstStory) {
			if (err) {
				return handleError(err, res);
			}
			res.send(200, firstStory);
		});
	});

	app.get("/data/:circleId/archives", ensure.circle, function (req, res) {
		var circleId = req.params.circleId;
		var query = req.query;
		var defaultLimit = 251; // TODO: Settings

		var limit = query.limit || defaultLimit;
		var startkey = query.startkey;
		var params = {
			limit: limit,
			startkey: startkey
		};

		db.archives.findByCircleId(circleId, params, function (err, archives) {
			if (err) {
				return handleError(err, res);
			}

			res.send(200, archives);
		});
	});

	app.get("/data/:circleId/archives/count", ensure.circle, function (req, res) {
		var circleId = req.params.circleId;
		db.archives.countByCircleId(circleId, function (err, count) {
			if (err) {
				return handleError(err, res);
			}
			res.send(200, count.toString());
		});
	});

	var getNewNotificationMessage = function (story, req) {
		var message = "Hi. You've been requested to look at a new story on Circle Blvd.\n\n";
		if (story.summary) {
			message += "Summary: " + story.summary + "\n\n";
		}
		if (story.description) {
			message += "Description: " + story.description + "\n\n";	
		}

		var protocol = "http";
		if (sslServer.isRunning()) {
			protocol = "https";
		}
		message += "View on Circle Blvd:\n" + 
			protocol + "://" + req.get('Host') + "/#/stories/" + story.id;
		
		return message;
	};

	// params: story, sender, recipients, message, subjectPrefix
	var sendStoryNotification = function (params, callback) {
		var story = params.story;
		var sender = params.sender;
		var recipients = params.recipients;
		var message = params.message;
		var subjectPrefix = params.subjectPrefix;

		db.settings.getAll(function (settings) {
			var smtpService = settings['smtp-service'];
			var smtpUsername = settings['smtp-login'];
			var smtpPassword = settings['smtp-password'];

			if (!smtpUsername || !smtpPassword || !smtpService) {
				return callback({
					status: 501,
					message: "The server needs SMTP login info before sending notifications. Check the admin page."
				})
			}

			smtpService = smtpService.value;
			smtpUsername = smtpUsername.value;
			smtpPassword = smtpPassword.value;

			var smtp = mailer.createTransport("SMTP", {
				service: smtpService,
				auth: {
					user: smtpUsername,
					pass: smtpPassword
				}
			});

			var toList = function () {
				var result = "";
				recipients.forEach(function (addressee) {
					result += addressee.name + " <" + addressee.email + ">,"
				});
				result = result.slice(0,-1); // remove last comma
				return result;
			}(); // closure;

			var opt = {
				from: sender.name + " via Circle Blvd <" + smtpUsername + ">",
				to: toList,
				replyTo: sender.name + " <" + sender.email + ">",
				subject: subjectPrefix + story.summary,
				text: message
			};

			// For testing:
			// console.log(opt);
			// callback(null, {ok: true});

			smtp.sendMail(opt, function (err, response) {
				smtp.close();
				if (err) {
					callback(err);
				}
				else {
					callback(null, response);
				}
			});
		});
	};

	var getCommentNotificationMessage = function (comment, story, req) {
		var message = comment.createdBy.name + " writes: ";
		message += comment.text;

		// TODO: Refactor duplicate code
		var protocol = "http";
		if (sslServer.isRunning()) {
			protocol = "https";
		}
		message += "\n\nView on Circle Blvd:\n" + 
			protocol + "://" + req.get('Host') + "/#/stories/" + story.id;
		
		return message;
	};


	var getNotificationRecipients = function (accounts) {
		var recipients = [];

		accounts.forEach(function (account) {
			var recipient = {
				name: account.name,
				email: account.email
			};

			// Use notification email addresses
			if (account.notifications && account.notifications.email) {
				recipient.email = account.notifications.email;
			}
			recipients.push(recipient);
		});

		return recipients;
	};

	var sendCommentNotification = function (params, req) {
		if (!params || !params.comment || !params.story || !params.user) {
			console.log("Bad call to send-comment notification. Doing nothing.");
			return;
		}

		var comment = params.comment;
		var story = params.story;
		var sender = params.user;
		if (sender.notifications && sender.notifications.email) {
			// Use notification email addresses
			sender.email = sender.notifications.email;
		}

		var participants = {};
		if (story.createdBy) {
			participants[story.createdBy.id] = {
				name: story.createdBy.name
			};
		}

		if (story.comments) {
			story.comments.forEach(function (comment) {
				if (comment.createdBy) {
					participants[comment.createdBy.id] = {
						name: comment.createdBy.name
					};
				}
			});
		}


		db.users.findByCircleAndName(story.projectId, story.owner, function (err, owner) {
			if (story.owner && err) {
				// Log, but we can continue.
				console.log("Comment notification: Cannot find story owner for story: " + story.id);
				console.log(err);
			}
			if (owner) {
				participants[owner._id] = {
					name: owner.name
				};
			}

			// Assert: We have all the participants now
			var recipientAccountIds = [];
			for (var accountId in participants) {
				// Remove the sender from the 'to' list
				if (accountId !== sender._id) {
					recipientAccountIds.push(accountId);
				}
			}

			if (recipientAccountIds.length === 0) {
				// We're done!
				return;
			}

			db.users.findMany(recipientAccountIds, function (err, accounts) {
				var sendParams = {
					story: story,
					sender: sender,
					message: getCommentNotificationMessage(comment, story, req),
					recipients: getNotificationRecipients(accounts),
					subjectPrefix: "new comment: "
				};

				sendStoryNotification(sendParams, function (err, response) {
					if (err) {
						console.log(err);
						return;
					}
					// Do nothing.
				});
			});
		});
	};

	var copyStory = function (story) {
		var copy = {};
		
		copy.projectId = story.projectId;
		copy.summary = story.summary;
		copy.isDeadline = story.isDeadline;
		copy.isNextMeeting = story.isNextMeeting;

		copy.createdBy = story.createdBy;
		copy.nextId = story.nextId;

		return copy;
	};

	var addStory = function (story, res) {
		var storyFor2ndTry = copyStory(story);
		db.stories.add(story, function (err, addedStory) {
			if (err) {
				return handleError(err, res);
			}

			res.send(200, addedStory);
		});
	};

	var getCreatedBy = function (req) {
		var createdBy = undefined;
		if (req.user) {
			createdBy = {
				name: req.user.name,
				id: req.user._id
			};
		}

		return createdBy;
	};

	// TODO: Ensure that the circleId specified in this
	// story is valid. Otherwise people can hack around
	// ways of accessing stories.
	//
	// This might be a thing to do at the data layer, or
	// we could do it higher up by getting the story
	// from the database and comparing the projectId to
	// the one specified, which might be a cleaner approach.
	app.post("/data/story/", ensure.auth, function (req, res) {
		var data = req.body;
		ensure.isCircle(data.projectId, req, res, function() {
			var story = copyStory(data);
			story.createdBy = getCreatedBy(req);

			addStory(story, res);			
		});
	});

	var getComment = function (text, req) {
		var comment = {
			text: text,
			createdBy: getCreatedBy(req),
			timestamp: Date.now()
		};

		return comment;
	};

	var saveStoryWithComment = function (story, req, res) {
		db.stories.save(story, 
			function (savedStory) {
				if (story.newComment) {
					var params = {
						story: savedStory,
						comment: story.newComment,
						user: req.user
					};
					sendCommentNotification(params, req);	
				}
				res.send(200, savedStory);
			},
			function (err) {
				handleError(err, res);
			}
		);
	};

	app.put("/data/story/", ensure.auth, function (req, res) {
		var story = req.body;
		var commentText = undefined;
		ensure.isCircle(story.projectId, req, res, function () {
			// TODO: This is an opportunity to clean up the API?
			// In other words, add /data/story/comment? Maybe.
			if (story.newComment) {
				story.newComment = getComment(story.newComment, req);
			}
			saveStoryWithComment(story, req, res);
		});	
	});

	app.put("/data/story/comment", ensure.auth, function (req, res) {
		// circleId, storyId, comment
		var data = req.body;
		if (!data.circleId || !data.storyId || !data.comment) {
			return res.send(400, "Missing circleId, storyId or comment.");
		}

		ensure.isCircle(data.circleId, req, res, function () {
			db.docs.get(data.storyId, function (err, story) {
				if (err) {
					return handleError(err, res);
				}
				if (story.projectId !== data.circleId) {
					return res.send(400);
				}

				story.newComment = getComment(data.comment, req);
				saveStoryWithComment(story, req, res);
			});
		});
	});

	// TODO: Refactor out the circle access
	app.get("/data/story/:storyId", ensure.auth, function (req, res) {
		var storyId = req.params.storyId;
		if (!storyId) {
			return res.send(400, "Story id required.");
		}

		db.docs.get(storyId, function (err, doc) {
			if (err) {
				return handleError(err, res);
			}

			if (!doc || doc.type !== "story") {
				return res.send(400, "Story not found");
			}

			var circleId = doc.projectId;
			var memberships = req.user.memberships;
			var hasAccess = false;
			memberships.forEach(function (membership) {
				if (membership.circle === circleId) {
					hasAccess = true;
				}
			});

			if (hasAccess) {
				// TODO: This is the plain db story document.
				// Is that ok? Or do we want to process it first?
				res.send(200, doc);
			}
			else {
				res.send(403, "Not a member of this circle");
			}
		});
	});

	app.put("/data/story/fix", ensure.auth, function (req, res) {
		var body = req.body;
		var story = body.story;
		var newNextId = body.newNextId;
		ensure.isCircle(story.projectId, req, res, function () {
			story.nextId = newNextId;
			db.stories.fix(story, function (response) {
				res.send(200, response);
			},
			function (err) {
				handleError(err, res);
			});
		});
	});

	app.put("/data/story/move", ensure.auth, function (req, res) {
		var body = req.body;
		var story = body.story;
		var newNextId = body.newNextId;
		ensure.isCircle(story.projectId, req, res, function () {
			db.stories.move(story, newNextId, function (response) {
				res.send(200, response);
			},
			function (err) {
				handleError(err, res);
			});
		});
	});

	var removeStory = function (story, res) {
		db.stories.remove(story, 
			function () {
				res.send(200);
			},
			function (err) {
				handleError(err, res);
			}
		);
	};

	app.put("/data/story/archive", ensure.auth, function (req, res) {
		var story = req.body;
		ensure.isCircle(story.projectId, req, res, function () {
			var stories = [];
			stories.push(story);

			db.archives.addStories(stories, 
			function (body) {
				// TODO: If this breaks then we have a data
				// integrity issue, because we have an archive
				// of a story that has not been deleted.
				removeStory(story, res);
			}, 
			function (err) {
				handleError(err, res);
			});
		});
	});

	app.put("/data/story/remove", ensure.auth, function (req, res) {
		var story = req.body;
		ensure.isCircle(story.projectId, req, res, function () {
			removeStory(story, res);
		});
	});


	app.post("/data/story/notify/new", ensure.auth, function (req, res) {
		var story = req.body;
		var sender = req.user;
		ensure.isCircle(story.projectId, req, res, function () {
			if (story.isOwnerNotified) {
				return res.send(412, "Story owner has already been notified.");
			}

			db.users.findByCircleAndName(story.projectId, story.owner, function (err, owner) {
				if (err) {
					return handleError(err, res);
				}

				// Use notification email addresses
				if (sender.notifications && sender.notifications.email) {
					sender.email = sender.notifications.email;
				}
				if (owner.notifications && owner.notifications.email) {
					owner.email = owner.notifications.email;
				}

				var params = {
					story: story,
					sender: sender,
					recipients: [owner],
					message: getNewNotificationMessage(story, req),
					subjectPrefix: "new story: "
				};

				sendStoryNotification(params, function (err, response) {
					if (err) {
						return handleError(err, res);
					}

					var onSuccess = function (savedStory) {
						res.send(200, response);
					};

					var onError = function (err) {
						handleError(err, res);
					};

					db.stories.markOwnerNotified(story, onSuccess, onError);
				});
			});
		});
	});

	// TODO: Where should this be on the client?
	app.put("/data/:circleId/settings/show-next-meeting", ensure.circleAdmin, function (req, res) {
		var showNextMeeting = req.body.showNextMeeting;
		var projectId = req.params.circleId;

		var handleNextMeeting = function (err, nextMeeting) {
			if (err) {
				handleError(err, res);
			}
			else {
				if (showNextMeeting) {
					// TODO: Should probably be in the data access layer.
					// TODO: Consider passing in the summary from the client,
					// as 'meeting' should be a configurable word.
					var story = {};
					story.summary = "Next meeting";
					story.isNextMeeting = true;

					addStory(story, res);
				}
				else {
					removeStory(nextMeeting, res);
				}
			}
		};

		var nextMeeting = db.stories.getNextMeetingByProjectId(projectId, handleNextMeeting);
	});

	app.post('/payment/donate', function (req, res) {
		var data = req.body;

		payment.stripe.charges.create({
			amount: data.stripeAmount,
			currency: "usd",
			card: data.stripeTokenId,
			description: "Donation",
			statement_description: "Donation"
		}, function (err, charge) {
			if (err) {
				return handleError(err, res);
			}

			res.send(200);
		});
	});

	app.post('/payment/subscribe', ensure.auth, function (req, res) {
		var data = req.body;
		var user = req.user;
		var planId = undefined;

		if (data.planName === 'Supporter') {
			planId = '2014-06-supporter';
		}
		if (data.planName === 'Organizer') {
			planId = '2014-06-organizer';
		}
		if (data.planName === 'Patron') {
			planId = '2014-06-patron';
		}
		if (!planId) {
			return res.send(400, "Invalid plan name");
		}

		var onSuccess = function (updatedUser) {
			res.send(200, updatedUser.subscription);
		};
		var onError = function (err) {
			// TODO: Technically it's possible to update
			// the Stripe data and not update our own 
			// data, so we should have a fall-back plan
			// if that happens.
			handleError(err, res);
		};

		if (!user.subscription) {
			// First time here!
			var newCustomer = {
				description: user.name + " (" + user.id + ")",
				card: data.stripeTokenId,
				plan: planId,
				metadata: {
					"id": user.id
				}
			};

			payment.stripe.customers.create(newCustomer, function (err, customer) {
				if (err) {
					return handleError(err, res);
				}

				var sub = {};
				sub.created = customer.created;
				sub.customerId = customer.id;
				sub.subscriptionId = customer.subscriptions.data[0].id;
				sub.planName = data.planName;

				user.subscription = sub;
				db.users.update(user, onSuccess, onError);
			});
		}
		else {
			// Returning customer
			var customerId = user.subscription.customerId;
			var subscriptionId = user.subscription.subscriptionId;
			var newPlan = {
				card: data.stripeTokenId,
				plan: planId
			};
			payment.stripe.customers.updateSubscription(
				customerId, subscriptionId, newPlan,
				function (err, subscription) {
					if (err) {
						return handleError(err, res);
					}

					var newSub = user.subscription;
					newSub.subscriptionId = subscription.id;
					newSub.planName = data.planName;
					newSub.updated = subscription.start;

					user.subscription = newSub;
					db.users.update(user, onSuccess, onError);
				}
			);
		}
	});

	app.put('/payment/subscribe/cancel', ensure.auth, function (req, res) {
		var user = req.user;
		if (!user.subscription) {
			return res.send(204);
		}

		// Just delete the Stripe customer, since they
		// only have one subscription anyway.
		var customerId = user.subscription.customerId;
		payment.stripe.customers.del(customerId, function (err, confirm) {
			if (err) {
				return handleError(err, res);
			}

			var onSuccess = function (updatedUser) {
				res.send(200, updatedUser.subscription);
			};
			var onError = function (err) {
				// TODO: Technically it's possible to update
				// the Stripe data and not update our own 
				// data, so we should have a fall-back plan
				// if that happens.
				handleError(err, res);
			};

			user.subscription = null;
			db.users.update(user, onSuccess, onError);
		});
	});

	app.post("/data/signup/now", function (req, res) {
		var data = req.body;

		var proposedAccount = {
			name: data.name,
			email: data.email,
			password: data.password
		};

		var proposedCircle = {
			name: data.circle
		};

		var userAccountCreated = function (newAccount) {
			createCircle(proposedCircle.name, newAccount.email, function (err, newCircle) {
				if (err) {
					handleError(err, res);
				}
				res.send(200, newCircle);
			});
		};

		db.users.findByEmail(proposedAccount.email, function (err, accountExists) {
			if (err) {
				return handleError(err, res);
			}

			if (accountExists) {
				return res.send(400, "That email address is already being used. Maybe try signing in?")
			}

			var isReadOnly = false;

			db.users.add(
				proposedAccount.name,
				proposedAccount.email, 
				proposedAccount.password,
				[], // no memberships at first
				isReadOnly,
				userAccountCreated, 
				function (err) {
					handleError(err, res);
				});
		});
	});

	app.post("/data/signup/waitlist", function (req, res) {
		var data = req.body;
		var request = {
			circle: data.circle,
			things: data.things,
			email: data.email
		};

		db.waitlist.add(request, function (err, body) {
			if (err) {
				return handleError(err, res);
			}
			res.send(200);
		});
	});

	app.get("/data/waitlist", ensure.mainframe, function (req, res) {
		db.waitlist.get(function (err, waitlist) {
			if (err) {
				return handleError(err, res);
			}
			res.send(200, waitlist);
		});
	});

	// The secret to bridging Angular and Express in a 
	// way that allows us to pass any path to the client.
	// 
	// Also, this depends on the static middleware being
	// near the top of the stack.
	app.get('*', function (req, res) {
		// Redirect to 'initialize' on first-time use.
		//
		// Use a cookie to control flow and prevent redirect loops.
		// Maybe not the best idea; feel free to have a better one.
		var usersExist = function(callback) {
			db.users.count(function (err, count) {
				if (err) {
					callback(err);
				}
				else if (count > 0) {
					callback(null, true);
				}
				else {
					callback(null, false);
				}
			});
		};

		usersExist(function (err, exist) {
			if (err) {
				return handleError(err, res);
			}
			
			if (!exist && !req.cookies.initializing) {
				res.cookie('initializing', 'yep');
				res.redirect('/#/initialize');
			}
			else {
				res.clearCookie('initializing');
				routes.index(req, res);			
			}
		});
	});

	http.createServer(app).listen(app.get('port'), function () {
		console.log("Express http server listening on port " + app.get('port'));
	});
		
	// Run an https server if we can.
	tryToCreateHttpsServer(function (err, success) {
		if (err) {
			console.log(err);
		}
		else {
			console.log(success);
		}
	});
};

var forceHttps = function(req, res, next) {
	if (!sslServer.isRunning()) {
		// Don't do anything if we can't do anything.
		return next();
	}

	if(req.secure 
		|| req.headers['x-forwarded-proto'] === 'https' 
		|| req.host === "localhost") {
		return next();	
	}
	res.redirect('https://' + req.get('Host') + req.url);
};

var getCookieSettings = function () {
	// TODO: Check settings to guess if https is running.
	// Or actually figure out if https is running, and if so
	// use secure cookies
	var oneHour = 3600000;
	var twoWeeks = 14 * 24 * oneHour;
	var cookieSettings = {
		path: '/',
		httpOnly: true,
		secure: false,
		maxAge: twoWeeks
	};

	return cookieSettings;
};

// configure Express
app.configure(function() {
	// TODO: Put port in config
	app.set('port', process.env.PORT || 3000);
	app.set('ssl-port', process.env.SSL_PORT || 4000);
	app.set('views', __dirname + '/views');
	app.set('view engine', 'ejs');
	app.use(forceHttps);
	app.use(express.compress());
	app.use(express.static(path.join(__dirname, 'public')));
	app.use(express.logger('dev'));
	app.use(express.cookieParser());
	app.use(express.bodyParser());
	app.use(express.methodOverride());

	var initSettingsOk = function (settings) {
		var sessionSecret = settings['session-secret'].value;
		var SessionStore = couchSessionStore(express.session);
		var cookieSettings = getCookieSettings();
		app.use(express.session({ 
			store: new SessionStore(),
			secret: sessionSecret,
			cookie: cookieSettings
		}));

		var stripeApiKey = settings['stripe-secret-key'];
		if (stripeApiKey) {
			payment.setApiKey(stripeApiKey.value);
		}

		initAuthentication();
		app.use(app.router);
		configureSuccessful();
	};

	settings.init(function (err, settings) {
		if (err) {
			console.log(err);
		}
		else {
			initSettingsOk(settings);
		}
	});
});