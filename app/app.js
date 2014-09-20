// app.js
var express = require('express');
var events  = require('events');
var http    = require('http');
var path    = require('path');
var routes  = require('./routes');

var compactModule = require('compact');

var auth   = require('./lib/auth-local.js');
var ensure = require('./lib/auth-ensure.js');
var limits = require('./lib/limits.js');
var errors = require('./lib/errors.js');
var db     = require('./lib/dataAccess.js').instance();
var notify = require('./lib/notify.js');

var sslServer = require('./lib/https-server.js');
var payment   = require('./lib/payment.js')();
var settings  = require('./lib/settings.js');

var usersRoutes = require('./routes/users');
var userRoutes  = require('./routes/user');
var initRoutes  = require('./routes/init');

var couchSessionStore = require('./lib/couch-session-store.js');

var ee = new events.EventEmitter();
var isReady = false;

var app = express();


// Middleware for data access
var guard = errors.guard;

var handle = function (res) {
    var fn = guard(res, function (data) {
        if (!data) {
            return res.send(204); // no content
        }
        res.send(200, data);
    }); 
    return fn;
};

var send = function (fn) {
    var middleware = function (req, res, next) {
        fn(handle(res));
    };

    return middleware;
};

var data = function (fn) {
    // A generic guard for callbacks. Call the
    // fn parameter. If there is an error, pass
    // it up to the error handler. Otherwise
    // append the result to the request object,
    // for the next middleware in line.
    var middleware = function (req, res, next) {
        fn(guard(res, function (data) {
            if (req.data) {
                // TODO: programmer error
            }
            req.data = data;
            next();
        }));
    };

    return middleware;
};

// caching middleware
var cache = function (ms) {
    var fn = function (req, res, next) {
        res.setHeader("Cache-Control", "max-age=" + ms);
        next();
    };
    return fn;
};
var sixMinutes = 5 * 60;

var tryToCreateHttpsServer = function (callback) {
    sslServer.create(app, callback);
};

var defineRoutes = function () {
    app.post('/auth/signin', auth.signin);
    app.get('/auth/signout', auth.signout);

    // Search engine things
    app.get('/sitemap.txt', routes.sitemap);

    // User routes (account actions. requires login access)
    app.get("/data/user", ensure.auth, userRoutes.user);
    app.put("/data/user/name", ensure.auth, userRoutes.updateName);
    app.put("/data/user/email", ensure.auth, userRoutes.updateEmail);
    app.put("/data/user/notificationEmail", ensure.auth, userRoutes.updateNotificationEmail)
    app.put("/data/user/password", ensure.auth, userRoutes.updatePassword);


    // User routes (circle actions. requires admin access)
    app.get("/data/:circleId/members", ensure.circleAdmin, function (req, res) {
        var circleId = req.params.circleId;
        db.users.findByCircleId(circleId, handle(res));
    });

    app.put("/data/:circleId/member/remove", ensure.circleAdmin, function (req, res) {
        var circleId = req.params.circleId;
        var reqUser = req.body;
        db.users.removeMembership(reqUser, circleId, handle(res));
    });

    app.post("/data/:circleId/member", ensure.circleAdmin, function (req, res) {
        var circleId = req.params.circleId;
        var member = req.body;
        db.users.addMembership(member, circleId, handle(res));
    });

    app.get("/data/:circleId/members/names", ensure.circle, function (req, res) {
        var circleId = req.params.circleId;
        db.users.findNamesByCircleId(circleId, handle(res));
    });

    // Init routes
    app.put("/data/initialize", initRoutes.init);


    // Settings!
    app.get("/data/settings", cache(sixMinutes), send(db.settings.get)); // public

    // TODO: This is not used. Assess.
    app.get("/data/settings/private", 
        ensure.mainframe, send(db.settings.getPrivate)); 

    app.get("/data/settings/authorized", 
        ensure.mainframe, send(db.settings.getAuthorized));

    app.put("/data/setting", ensure.mainframe, function (req, res) {
        var data = req.body;

        var invalidateSettingsCache = function () {
            app.set('settings', null);
        };

        var onSettingsUpdate = function (setting) {
            if (setting.name === 'ssl-key-path' || setting.name === 'ssl-cert-path') {
                // TODO: Tell the client if we started the server?
                tryToCreateHttpsServer();
            }
            if (setting.name === 'stripe-secret-key') {
                payment.setApiKey(setting.value);
            }

            invalidateSettingsCache();
            res.send(200);
        };

        db.settings.update(data, guard(res, onSettingsUpdate));;
    });


    // Circles!
    app.get("/data/circles", ensure.auth, function (req, res) {
        db.circles.findByUser(req.user, handle(res));
    });

    app.get("/data/circles/all", 
        ensure.mainframe, 
        send(db.circles.getAll));

    app.post("/data/circle", 
        ensure.auth, limits.circle, limits.users.circle, function (req, res) {
        //
        var circleName = req.body.name;
        var user = req.user;

        if (!circleName) {
            var message = "A 'name' property is required, for naming the circle.";
            return res.send(400, message);
        }

        db.circles.create(circleName, user.email, handle(res));
    });

    app.post("/data/circle/admin", ensure.mainframe, function (req, res) {
        var circle = req.body.circle;
        var admin = req.body.admin;

        if (!admin.email) {
            var message = "An email address for an administrative user " +
                "is required when making a circle.";
            return res.send(400, message);
        }

        db.circles.create(circle.name, admin.email, handle(res));
    });

    app.put("/data/circle", ensure.mainframe, function (req, res) {
        var circle = req.body;
        db.circles.update(circle, handle(res));
    });

    app.get("/data/circle/:circleId", ensure.circle, function (req, res) {
        var circleId = req.params.circleId;
        db.circles.get(circleId, handle(res));
    });

    app.put("/data/circle/:circleId/name", ensure.circleAdmin, function (req, res) {
        var data = req.body;
        var circleId = req.params.circleId;
        db.circles.get(circleId, guard(res, function (circle) {
            circle.name = data.name;
            db.circles.update(circle, handle(res));
        }));
    });

    // Invites!
    app.get("/data/:circleId/invite/:count", ensure.circle, function (req, res) {
        var invite = {
            circleId: req.params.circleId,
            count: req.params.count || 1
        };

        db.invites.create(invite, handle(res));
    });

    app.get("/data/invite/:inviteId", function (req, res) {
        var inviteId = req.params.inviteId;
        db.invites.get(inviteId, handle(res));
    });

    // Groups!
    app.get("/data/:circleId/groups", ensure.circle, function (req, res) {
        var circleId = req.params.circleId;
        db.groups.findByProjectId(circleId, handle(res));
    });

    // TODO: We'll turn groups on at a later time, as we
    // transition toward hosting larger groups, but in the 
    // mean time this is just a security hole.
    //
    // TODO: Ensure circle access
    // app.post("/data/group", ensureAdministrator, function (req, res) {
    //  var data = req.body;

    //  var group = {}; 
    //  group.projectId = data.projectId;
    //  group.name = data.name;

    //  db.groups.add(group, handle(res));
    // });

    // // TODO: Ensure circle access
    app.get("/data/group/:groupId", ensure.auth, function (req, res) {
        var groupId = req.params.groupId;
        db.groups.findById(groupId, handle(res));
    });

    // // TODO: Ensure circle access
    // app.put("/data/group/remove", ensureAdministrator, function (req, res) {
    //  var group = req.body;

    //  db.groups.remove(group, 
    //      function () {
    //          res.send(200);
    //      },
    //      function (err) {
    //          errors.handle(err, res);
    //      }
    //  );
    // });


    // Story routes
    app.get("/data/:circleId/stories", ensure.circle, function (req, res) {
        var circleId = req.params.circleId;
        db.stories.findByListId(circleId, handle(res));
    });

    // TODO: combine this with /stories to return one object with 
    // both the story list and the first story (in two different things)
    app.get("/data/:circleId/first-story", ensure.circle, function (req, res) {
        var circleId = req.params.circleId;
        db.stories.getFirstByProjectId(circleId, handle(res));
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

        db.archives.findByCircleId(circleId, params, handle(res));
    });

    app.get("/data/:circleId/archives/count", ensure.circle, function (req, res) {
        var circleId = req.params.circleId;
        db.archives.countByCircleId(circleId, guard(res, function (count) {
            res.send(200, count.toString());
        }));
    });

    // Checklists!
    app.post("/data/:circleId/list", ensure.circle, function (req, res) {
        var list = {
            name: req.body.name,
            description: req.body.description,
            circleId: req.params.circleId
        };
        db.lists.add(list, handle(res));
    });

    app.get("/data/:circleId/lists", ensure.circle, function (req, res) {
        var circleId = req.params.circleId;
        db.lists.byCircleId(circleId, handle(res));
    });

    app.get("/data/:circleId/:listId/stories", ensure.circle, function (req, res) {
        var circleId = req.params.circleId;
        var listId = req.params.listId;
        db.stories.findByListId(listId, handle(res));
    });

    app.get("/data/:circleId/:listId/first-story", ensure.circle, function (req, res) {
        var listId = req.params.listId;
        db.stories.getFirstByProjectId(listId, handle(res));
    });

    var copyStory = function (story) {
        var copy = {};
        
        copy.projectId = story.projectId;
        copy.listId = story.listId;
        
        copy.summary = story.summary;
        copy.description = story.description;
        copy.owner = story.owner;
        copy.labels = story.labels;

        copy.isDeadline = story.isDeadline;
        copy.isNextMeeting = story.isNextMeeting;

        copy.createdBy = story.createdBy;
        copy.nextId = story.nextId;

        return copy;
    };

    var addStory = function (story, res) {
        db.stories.add(story, handle(res));
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
        var circleId = data.projectId;
        ensure.isCircle(circleId, req, res, function() {
            // Add the story if we're under the server limit.
            limits.users.story(circleId, guard(res, function () {
                var story = copyStory(data);
                story.createdBy = getCreatedBy(req);
                console.log("STORY: ");
                console.log(story);
                addStory(story, res);
            }));
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
                    notify.newComment(params, req); 
                }
                res.send(200, savedStory);
            },
            function (err) {
                errors.handle(err, res);
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
            db.docs.get(data.storyId, guard(res, function (story) {
                if (story.projectId !== data.circleId) {
                    return res.send(400);
                }

                story.newComment = getComment(data.comment, req);
                saveStoryWithComment(story, req, res);
            }));
        });
    });

    app.get("/data/story/:storyId", ensure.auth, function (req, res) {
        var storyId = req.params.storyId;
        if (!storyId) {
            return res.send(400, "Story id required.");
        }

        db.docs.get(storyId, guard(res, function (story) {
            if (!story || story.type !== "story") {
                return res.send(400, "Story not found");
            }

            var circleId = story.projectId;
            ensure.isCircle(circleId, req, res, function () {
                res.send(200, story);
            });
        }));
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
                errors.handle(err, res);
            });
        });
    });

    app.put("/data/story/move", ensure.auth, function (req, res) {
        var body = req.body;
        var story = body.story;
        var newNextId = body.newNextId;
        ensure.isCircle(story.projectId, req, res, function () {
            db.stories.move(story, newNextId, handle(res));
        });
    });

    var removeStory = function (story, res) {
        db.stories.remove(story, handle(res));
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
                errors.handle(err, res);
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
            notify.newStory(story, sender, req, handle(res));
        });
    });

    // TODO: Where should this be on the client?
    app.put("/data/:circleId/settings/show-next-meeting", ensure.circleAdmin, function (req, res) {
        var showNextMeeting = req.body.showNextMeeting;
        var projectId = req.params.circleId;

        var handleNextMeeting = guard(res, function (nextMeeting) {
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
        });

        var nextMeeting = db.stories.getNextMeetingByProjectId(projectId, handleNextMeeting);
    });

    app.post('/payment/donate', function (req, res) {
        var data = req.body;
        var stripeTokenId = data.stripeTokenId;
        var amount = data.stripeAmount

        payment.donate(stripeTokenId, amount, handle(res));
    });

    app.post('/payment/subscribe', ensure.auth, function (req, res) {
        var data = req.body;

        var user = req.user;
        var stripeTokenId = data.stripeTokenId;
        var planName = data.planName;

        payment.subscribe(user, stripeTokenId, planName, handle(res));
    });

    app.put('/payment/subscribe/cancel', ensure.auth, function (req, res) {
        var user = req.user;
        if (!user.subscription) {
            return res.send(204);
        }

        payment.unsubscribe(user, handle(res));
    });

    var createUser = function (proposedAccount, callback) {
        var addSuccess = function (newAccount) {
            callback(null, newAccount);
        };

        var addError = function (err) {
            callback(err);
        };

        db.users.findByEmail(proposedAccount.email, function (err, accountExists) {
            if (err) {
                return callback(err);
            }
            if (accountExists) {
                var error = new Error("That email address is already being used. Maybe try signing in?");
                error.status = 400;
                return callback(error);
            }

            var isReadOnly = false;
            db.users.add(
                proposedAccount.name,
                proposedAccount.email, 
                proposedAccount.password,
                [], // no memberships at first
                isReadOnly,
                addSuccess, 
                addError);
        });
    };

    var createAccount = function (proposedAccount, circle, callback) {
        var userAccountCreated = function (newAccount) {
            db.circles.create(circle.name, newAccount.email, callback);
        };

        createUser(proposedAccount, function (err, newAccount) {
            if (err) {
                callback(err);
                return;
            }
            userAccountCreated(newAccount);
        });
    };

    app.post("/data/signup/invite", function (req, res) {
        var data = req.body;
        var proposedAccount = data.account;
        var invite = data.invite;

        var invitationAccepted = function (dbInvite, group) {
            createUser(proposedAccount, guard(res, function (account) {
                // Add circle membership to account
                var newMembership = {
                    circle: dbInvite.circleId,
                    group: group.id,
                    level: "member"
                };
                account.memberships.push(newMembership);
                db.users.addMembership(account, dbInvite.circleId, handle(res));
                // Done.
            }));
        };

        db.groups.findImpliedByCircleId(invite.circleId, guard(res, function (group) {
            if (!group) {
                res.send(400, "Could not find implied group for invite.");
                return;
            }
            db.invites.get(invite._id, guard(res, function (dbInvite) {
                if (!dbInvite) {
                    res.send(404);
                    return;
                }
                if (dbInvite.count <= 0) {
                    res.send(403);
                    return;
                }
                db.invites.accept(dbInvite, guard(res, function () {
                    invitationAccepted(dbInvite, group);
                }));
            }));    
        }));
    });

    app.post("/data/signup/now", limits.circle, function (req, res) {
        var data = req.body;
        var proposedAccount = {
            name: data.name,
            email: data.email,
            password: data.password
        };
        var proposedCircle = {
            name: data.circle
        };
        createAccount(proposedAccount, proposedCircle, handle(res));
    });

    app.post("/data/signup/waitlist", function (req, res) {
        var data = req.body;
        var request = {
            circle: data.circle,
            things: data.things,
            email: data.email
        };

        db.waitlist.add(request, handle(res));
    });

    app.get("/data/waitlist", ensure.mainframe, send(db.waitlist.get));

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
                    return callback(err);
                }
                callback(null, count > 0);
            });
        };

        usersExist(guard(res, function (exist) {
            if (!exist && !req.cookies.initializing) {
                res.cookie('initializing', 'yep');
                res.redirect('/#/initialize');
            }
            else {
                res.clearCookie('initializing');
                routes.index(req, res, app);            
            }
        }));
    });
};

var startServer = function () {
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
}

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

var appSettings = function (req, res, next) {
    if (!app.get('settings')) {
        db.settings.getAll(function (err, settings) {
            if (err) {
                errors.log(err);
                return next();
            }
            app.set('settings', settings);
            next();
        });
    }
    else {
        next();
    }
};

var canonicalDomain = function (req, res, next) {
    var settings = app.get('settings');
    if (!settings) {
        return next();
    }

    var domainName = undefined;
    if (settings['domain-name'] && settings['domain-name'].value) {
        domainName = settings['domain-name'].value.trim();
    }

    if (!domainName || req.host === domainName) {
        return next();
    }

    var hostAndPort = req.get('Host');
    var redirectToHost = domainName;
    if (hostAndPort) {
        redirectToHost = hostAndPort.replace(req.host, domainName);
    }

    var url = req.protocol + "://" + redirectToHost + req.originalUrl;
    res.redirect(301, url);
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
    app.set('port', process.env.PORT || 3000);
    app.set('ssl-port', process.env.SSL_PORT || 4000);
    app.set('views', __dirname + '/views');
    app.set('view engine', 'ejs');
    app.use(forceHttps);
    // TODO: canonicalDomain will not work for the first request
    // after the settings are changed.
    app.use(canonicalDomain);
    app.use(express.compress());

    // for minifying JavaScript
    var compact = compactModule.createCompact({
        srcPath: __dirname + '/public/',
        destPath: __dirname + '/public/_js/',
        webPath: '/_js/',
        debug: false
    });

    compact.addNamespace('lib')
        .addJs('lib/angular/angular.js')
        .addJs('lib/angular/angular-route.js')
        .addJs('lib/angular/angular-sanitize.js')
        .addJs('lib/store/store.min.js')
        .addJs('lib/yui/dd-dependencies.js')
        .addJs('lib/yui/dd.js')
        .addJs('lib/autosize/jquery.autosize.min.js')
        .addJs('lib/typeahead/0.10.2.js');

    compact.addNamespace('app')
        .addJs('main/app.js');

    compact.addNamespace('services')
        .addJs('services/analytics.js')
        .addJs('services/lib.js')
        .addJs('services/hacks.js')
        .addJs('services/signInName.js')
        .addJs('services/session.js')
        .addJs('services/stories.js')
        .addJs('services/errors.js')
        .addJs('main/services.js');

    compact.addNamespace('controllers')
        .addJs('ui/controllers/topLevel.js')
        .addJs('main/controllers.js')
        .addJs('ui/controllers/story.js')
        .addJs('ui/controllers/storyList.js')
        .addJs('ui/controllers/storySummary.js')
        .addJs('ui/controllers/home.js')
        .addJs('ui/controllers/signin.js')
        .addJs('ui/controllers/archive.js')
        .addJs('ui/controllers/lists.js')
        .addJs('ui/controllers/profile.js')
        .addJs('ui/controllers/invite.js')
        .addJs('ui/controllers/docs.js')
        .addJs('ui/controllers/sponsor.js')
        .addJs('ui/controllers/about.js')
        .addJs('ui/controllers/donate.js')
        .addJs('ui/controllers/admin.js')
        .addJs('ui/controllers/mainframe.js')
        .addJs('ui/controllers/fix.js')

    compact.addNamespace('main')
        .addJs('main/filters.js')
        .addJs('main/directives.js')

    app.use(express.static(path.join(__dirname, 'public')));
    app.use(compact.middleware([
        'lib', 
        'app', 
        'services', 
        'controllers', 
        'main'
    ]));
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

        // Init authentication
        auth.attach(app);
        
        // Set settings
        app.use(appSettings);
        
        // Routes
        app.use(app.router);
        // Catch errors
        app.use(function (err, req, res, next) {
            if (err) {
                return errors.handle(err, res);
            }
            // TODO: Should not get here.
        });
        defineRoutes();
        ready();
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

function ready() {
    isReady = true;
    ee.emit('circle-blvd-app-is-ready');
}

exports.whenReady = function (callback) {
    if (isReady) {
        return callback();
    }
    ee.once('circle-blvd-app-is-ready', function () {
        callback();
    });
};

exports.express = app;
exports.startServer = startServer;