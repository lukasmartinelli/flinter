/*eslint no-underscore-dangle:0*/
'use strict';
var Q = require('q');
var Repo = require('./models').Repo;
var Commit = require('./models').Commit;
var flintCommit = require('./flint').flintCommit;

/** Remove mongo specific properties from a document */
function demongify(doc) {
    doc = doc.toObject();
    delete doc._id;
    delete doc.__v;
    return doc;
}

exports.all = function() {
    return Repo.find({}).exec().then(function(repos) {
        return repos.map(demongify);
    });
};

exports.search = function(query) {
    return Repo.find({repo: new RegExp('^' + query)}).exec().then(function(repos) {
        if(repos.length === 0) {
            return Repo.find({repo: new RegExp(query + '$')}).exec();
        }
        return repos;
    });
};

/** Activate subscription on a repo. Only if a repo is subscribed to
 *  commits are actually checked with flint. */
exports.subscribe = function(fullName, subscribed) {
    var repo = { repo: fullName, subscribed: subscribed };
    return Repo.findOneAndUpdate({repo: fullName}, repo, {upsert: true}).exec().then(demongify);
};

/** Return repo including all commits */
exports.get = function(fullName) {
    var queries = Q.all([
        Repo.findOne({ repo: fullName }).exec(),
        Commit.find({ repo: fullName }).exec()
    ]);
    return queries.then(function(results) {
        if(results[0] === null) {
            throw 'Repo ' + fullName + ' not found in db';
        }

        var repo = demongify(results[0]);
        repo.commits = results[1].map(demongify).map(function(c) {
            delete c.repo;
            return c;
        });
        return repo;
    });
};

exports.lastCommit = function(fullName) {
    return Commit
        .find({ repo: fullName })
        .sort({ date: 'desc'})
        .exec().then(function(commits){
            if(commits.length > 0) {
                return commits[0];
            } else {
                throw 'No commits exist for repo ' + fullName;
            }
        });
};

/* Store commits of push event in repository and run flint on
 * the latest commit */
exports.checkPush = function(repo, commits) {
    commits = commits.map(function(commit) {
        commit.repo = repo;
        commit.date = new Date(commit.date);
        commit.status = 'unchecked';
        return commit;
    });
    return Commit.create(commits).then(function () {
        return exports.lastCommit(repo);
    }, function(err) {
        var duplicateKeyCode = 11000;
        if (err && err.code === duplicateKeyCode) {
            console.log('Tried to insert existing commit');
            return exports.lastCommit(repo);
        }
    }).then(function(commit) {
        if(commit.status === 'unchecked') {
            return flintCommit(commit).then(function(warnings) {
                commit.status = warnings.length > 0 ? 'failed' : 'success';
                commit.warnings = warnings;
                commit.save();
                console.log('Commit ' + commit.sha + ' in repo ' + commit.repo + ' has ' + warnings.length + ' warnings');
                commit = demongify(commit);
                return commit;
            });
        } else {
            commit = demongify(commit);
            return commit;
        }
    });
};
