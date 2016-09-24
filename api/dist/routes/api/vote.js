'use strict';

var config = require('/opt/cocorico/api-web/config.json');

var keystone = require('keystone');
var Web3 = require('web3');
var async = require('async');
var metafetch = require('metafetch');
var fetch = require('node-fetch');
var webshot = require('webshot');
var md5 = require('md5');

var Vote = keystone.list('Vote'),
    Source = keystone.list('Source');

exports.list = function (req, res) {
  Vote.model.find().exec(function (err, votes) {
    if (err) return res.apiError('database error', err);

    return res.apiResponse({ votes: votes });
  });
};

exports.get = function (req, res) {
  Vote.model.findById(req.params.voteId).exec(function (err, vote) {
    if (err) return res.apiError('database error', err);

    if (!vote) return res.status(404).send();

    return res.apiResponse({ vote: vote });
  });
};

exports.getBySlug = function (req, res) {
  Vote.model.findOne({ slug: req.params.voteSlug }).exec(function (err, vote) {
    if (err) return res.apiError('database error', err);

    if (!vote) return res.status(404).send();

    return res.apiResponse({ vote: vote });
  });
};

exports.create = function (req, res) {
  var app = req.user;

  var url = decodeURIComponent(req.body.url);
  if (!url) {
    return res.status(400).send({ error: 'missing url' });
  }

  var labels = [];

  if (req.body.labels) {
    try {
      labels = JSON.parse(req.body.labels);
    } catch (e) {
      return res.status(400).send({
        error: 'invalid labels with error \'' + e.message + '\''
      });
    }
  }

  return async.waterfall([function (callback) {
    return !app.isValidURL(url) ? callback({ code: 403, error: 'invalid url' }, null) : Vote.model.findOne({ url: url }).exec(function (err, vote) {
      return callback(err, vote);
    });
  },
  // Step 2: check there is no vote for this URL and fetch meta fields
  // if there is not.
  function (vote, callback) {
    return !!vote ? callback({ code: 400, error: 'invalid url' }, null) : Vote.model({
      app: app.id,
      url: url,
      restricted: req.body.restricted === 'true',
      labels: labels
    }).save(function (err, vote) {
      return callback(err, vote);
    });
  }], function (err, vote) {
    if (err) {
      if (err.code) {
        res.status(err.code);
      }
      if (err.error) {
        return res.apiError(err.error);
      }
      return res.apiError(err);
    }
    return res.apiResponse({ vote: vote });
  });
};

exports.update = function (req, res) {
  var voteId = req.params.voteId;

  Vote.model.findById(voteId).exec(function (findVoteErr, vote) {
    if (findVoteErr) return res.apiError('database error', findVoteErr);

    if (!vote) return res.status(404).send();

    if (vote.app !== req.user.id) {
      return res.status(403).send();
    }

    for (propertyName in vote) {
      if (propertyName in req.body) {
        vote[propertyName] = req.body[propertyName];
      }
    }

    return vote.save(function (err) {
      if (err) return res.apiError('database error', err);

      return res.apiResponse({ vote: vote });
    });
  });
};

// exports.resultPerDate = function(req, res) {
//     var voteId = req.params.voteId;
//
//     Vote.model.findById(voteId)
//         .exec((err, vote) => {
//             if (err)
//                 return res.apiError('database error', err);
//
//             if (!vote)
//                 return res.status(404).send();
//
//             res.apiResponse({result : null});
//         });
// }
//
// exports.resultPerGender = function(req, res) {
//     var voteId = req.params.voteId;
//
//     Vote.model.findById(voteId)
//         .exec((err, vote) => {
//             if (err)
//                 return res.apiError('database error', err);
//
//             if (!vote)
//                 return res.status(404).send();
//
//             res.apiResponse({result : null});
//         });
// }
//
// exports.resultPerAge = function(req, res) {
//     var voteId = req.params.voteId;
//
//     Vote.model.findById(voteId)
//         .exec((err, vote) => {
//             if (err)
//                 return res.apiError('database error', err);
//
//             if (!vote)
//                 return res.status(404).send();
//
//             res.apiResponse({result : null});
//         });
// }

exports.result = function (req, res) {
  var voteId = req.params.voteId;

  Vote.model.findById(voteId).exec(function (findVoteErr, vote) {
    if (findVoteErr) return res.apiError('database error', findVoteErr);

    if (!vote) return res.status(404).send();

    var web3 = new Web3();
    web3.setProvider(new web3.providers.HttpProvider('http://127.0.0.1:8545'));

    return web3.eth.contract(JSON.parse(vote.voteContractABI)).at(vote.voteContractAddress, function (err, voteInstance) {
      return res.apiResponse({ result: voteInstance.getVoteResults().map(function (s) {
          return parseInt(s);
        }) });
    });
  });
};

exports.embed = function (req, res) {
  if (!req.headers.referer) {
    return res.status(400).send({ error: 'missing referer' });
  }

  return async.waterfall([function (callback) {
    return Vote.model.findById(req.params.voteId).exec(callback);
  }, function (vote, callback) {
    return !vote ? callback({ code: 404, msg: 'vote not found' }, null) : callback(null, vote);
  },
  // Step 0: fetch the page meta to get the unique URL
  function (vote, callback) {
    return metafetch.fetch(req.headers.referer, {
      flags: { images: false, links: false },
      http: { timeout: 30000 }
    }, function (err, meta) {
      return callback(err, vote, meta);
    });
  },
  // Step 1: find the corresponding Source
  function (vote, meta, callback) {
    return Source.model.findOne({ url: meta.url }).exec(function (err, source) {
      return callback(err, vote, meta, source);
    });
  },
  // Step 2: continue if the source does not exist
  function (vote, meta, source, callback) {
    return !!source ? callback({ code: 400, msg: 'already listed' }, null) : callback(null, vote, meta, source);
  },
  // Step 3: fetch the content of the page to check that the vote
  // button embed code is present
  function (vote, meta, source, callback) {
    return fetch(meta.url).then(function (fetchRes) {
      if (!fetchRes.ok || fetchRes.status !== 200) {
        return callback({ code: 400, msg: 'unable to fetch page' }, null);
      }
      if (fetchRes.headers.get('content-type').indexOf('text/html') < 0) {
        return callback({ code: 400, msg: 'invalid content type' }, null);
      }

      return fetchRes.text();
    }).then(function (html) {
      // FIXME: check the actual vote button embed button
      if (html.indexOf('<iframe') < 0) {
        return callback({ code: 400, msg: 'missing embed code' });
      }

      if (!meta.image) {
        var filename = md5(meta.url) + '.jpg';
        return webshot(meta.url, '/vagrant/app/public/img/screenshot' + filename, function (err) {
          if (!err) {
            meta.image = filename;
          }
          return callback(err, vote, meta, source);
        });
      } else {
        return callback(null, vote, meta, source);
      }
    });
  }, function (vote, meta, source, callback) {
    return Source.model({
      url: meta.url,
      vote: vote,
      title: meta.title,
      description: meta.description,
      type: meta.type,
      image: meta.image
    }).save(callback);
  }], function (err, source) {
    if (err) {
      if (err.code) {
        res.status(err.code);
        if (err.msg) {
          return res.send({ error: err.msg });
        }
        return res.send();
      }
      return res.apiError(err);
    }
    return res.apiResponse({ source: source });
  });
};

exports.permissions = function (req, res) {
  var voteId = req.params.voteId;

  Vote.model.findById(voteId).exec(function (err, vote) {
    if (err) {
      return res.apiError('database error', err);
    }

    if (!vote) {
      return res.status(404).send();
    }

    return res.apiResponse({
      permissions: {
        read: config.capabilities.vote.read,
        vote: !!req.user && vote.userIsAuthorizedToVote(req.user),
        update: config.capabilities.vote.update
      }
    });
  });
};

exports.getTransactions = function (req, res) {

  var voteId = req.params.voteId;

  return Vote.model.findById(voteId).exec(function (err, vote) {
    if (err) {
      return res.apiError('database error', err);
    }

    if (!vote) {
      return res.status(404).send();
    }

    // FIXME: Add 403 if vote.status != complete

    var web3 = new Web3();
    web3.setProvider(new web3.providers.HttpProvider('http://127.0.0.1:8545'));

    return web3.eth.contract(JSON.parse(vote.voteContractABI)).at(vote.voteContractAddress, function (atErr, instance) {
      if (atErr) {
        return res.apiError('blockchain error', atErr);
      }

      var ballotEvent = instance.Ballot(null, { fromBlock: 0, toBlock: 'latest' });
      return ballotEvent.get(function (ballotEventErr, result) {
        if (ballotEventErr) {
          return res.apiError('blockchain error', ballotEventErr);
        }

        return res.apiResponse({ transactions: result });
      });
    });
  });
};
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbIi4uLy4uLy4uL3NyYy9yb3V0ZXMvYXBpL3ZvdGUuanMiXSwibmFtZXMiOlsiY29uZmlnIiwicmVxdWlyZSIsImtleXN0b25lIiwiV2ViMyIsImFzeW5jIiwibWV0YWZldGNoIiwiZmV0Y2giLCJ3ZWJzaG90IiwibWQ1IiwiVm90ZSIsImxpc3QiLCJTb3VyY2UiLCJleHBvcnRzIiwicmVxIiwicmVzIiwibW9kZWwiLCJmaW5kIiwiZXhlYyIsImVyciIsInZvdGVzIiwiYXBpRXJyb3IiLCJhcGlSZXNwb25zZSIsImdldCIsImZpbmRCeUlkIiwicGFyYW1zIiwidm90ZUlkIiwidm90ZSIsInN0YXR1cyIsInNlbmQiLCJnZXRCeVNsdWciLCJmaW5kT25lIiwic2x1ZyIsInZvdGVTbHVnIiwiY3JlYXRlIiwiYXBwIiwidXNlciIsInVybCIsImRlY29kZVVSSUNvbXBvbmVudCIsImJvZHkiLCJlcnJvciIsImxhYmVscyIsIkpTT04iLCJwYXJzZSIsImUiLCJtZXNzYWdlIiwid2F0ZXJmYWxsIiwiY2FsbGJhY2siLCJpc1ZhbGlkVVJMIiwiY29kZSIsImlkIiwicmVzdHJpY3RlZCIsInNhdmUiLCJ1cGRhdGUiLCJmaW5kVm90ZUVyciIsInByb3BlcnR5TmFtZSIsInJlc3VsdCIsIndlYjMiLCJzZXRQcm92aWRlciIsInByb3ZpZGVycyIsIkh0dHBQcm92aWRlciIsImV0aCIsImNvbnRyYWN0Iiwidm90ZUNvbnRyYWN0QUJJIiwiYXQiLCJ2b3RlQ29udHJhY3RBZGRyZXNzIiwidm90ZUluc3RhbmNlIiwiZ2V0Vm90ZVJlc3VsdHMiLCJtYXAiLCJzIiwicGFyc2VJbnQiLCJlbWJlZCIsImhlYWRlcnMiLCJyZWZlcmVyIiwibXNnIiwiZmxhZ3MiLCJpbWFnZXMiLCJsaW5rcyIsImh0dHAiLCJ0aW1lb3V0IiwibWV0YSIsInNvdXJjZSIsInRoZW4iLCJmZXRjaFJlcyIsIm9rIiwiaW5kZXhPZiIsInRleHQiLCJodG1sIiwiaW1hZ2UiLCJmaWxlbmFtZSIsInRpdGxlIiwiZGVzY3JpcHRpb24iLCJ0eXBlIiwicGVybWlzc2lvbnMiLCJyZWFkIiwiY2FwYWJpbGl0aWVzIiwidXNlcklzQXV0aG9yaXplZFRvVm90ZSIsImdldFRyYW5zYWN0aW9ucyIsImF0RXJyIiwiaW5zdGFuY2UiLCJiYWxsb3RFdmVudCIsIkJhbGxvdCIsImZyb21CbG9jayIsInRvQmxvY2siLCJiYWxsb3RFdmVudEVyciIsInRyYW5zYWN0aW9ucyJdLCJtYXBwaW5ncyI6Ijs7QUFBQSxJQUFJQSxTQUFTQyxRQUFRLG1DQUFSLENBQWI7O0FBRUEsSUFBSUMsV0FBV0QsUUFBUSxVQUFSLENBQWY7QUFDQSxJQUFJRSxPQUFPRixRQUFRLE1BQVIsQ0FBWDtBQUNBLElBQUlHLFFBQVFILFFBQVEsT0FBUixDQUFaO0FBQ0EsSUFBSUksWUFBWUosUUFBUSxXQUFSLENBQWhCO0FBQ0EsSUFBSUssUUFBUUwsUUFBUSxZQUFSLENBQVo7QUFDQSxJQUFJTSxVQUFVTixRQUFRLFNBQVIsQ0FBZDtBQUNBLElBQUlPLE1BQU1QLFFBQVEsS0FBUixDQUFWOztBQUVBLElBQUlRLE9BQU9QLFNBQVNRLElBQVQsQ0FBYyxNQUFkLENBQVg7QUFBQSxJQUNFQyxTQUFTVCxTQUFTUSxJQUFULENBQWMsUUFBZCxDQURYOztBQUdBRSxRQUFRRixJQUFSLEdBQWUsVUFBU0csR0FBVCxFQUFjQyxHQUFkLEVBQW1CO0FBQ2hDTCxPQUFLTSxLQUFMLENBQVdDLElBQVgsR0FDR0MsSUFESCxDQUNRLFVBQUNDLEdBQUQsRUFBTUMsS0FBTixFQUFnQjtBQUNwQixRQUFJRCxHQUFKLEVBQ0UsT0FBT0osSUFBSU0sUUFBSixDQUFhLGdCQUFiLEVBQStCRixHQUEvQixDQUFQOztBQUVGLFdBQU9KLElBQUlPLFdBQUosQ0FBZ0IsRUFBQ0YsT0FBT0EsS0FBUixFQUFoQixDQUFQO0FBQ0QsR0FOSDtBQU9ELENBUkQ7O0FBVUFQLFFBQVFVLEdBQVIsR0FBYyxVQUFTVCxHQUFULEVBQWNDLEdBQWQsRUFBbUI7QUFDL0JMLE9BQUtNLEtBQUwsQ0FBV1Es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LENBQWdDLHVCQUFoQyxDQUFqQjs7QUFFQSxXQUFPSCxLQUFLSSxHQUFMLENBQVNDLFFBQVQsQ0FBa0JwQixLQUFLQyxLQUFMLENBQVdoQixLQUFLb0MsZUFBaEIsQ0FBbEIsRUFDSkMsRUFESSxDQUVEckMsS0FBS3NDLG1CQUZKLEVBR0QsVUFBQ2lDLEtBQUQsRUFBUUMsUUFBUixFQUFxQjtBQUNuQixVQUFJRCxLQUFKLEVBQVc7QUFDVCxlQUFPbkYsSUFBSU0sUUFBSixDQUFhLGtCQUFiLEVBQWlDNkUsS0FBakMsQ0FBUDtBQUNEOztBQUVELFVBQUlFLGNBQWNELFNBQVNFLE1BQVQsQ0FBZ0IsSUFBaEIsRUFBc0IsRUFBQ0MsV0FBVSxDQUFYLEVBQWNDLFNBQVMsUUFBdkIsRUFBdEIsQ0FBbEI7QUFDQSxhQUFPSCxZQUFZN0UsR0FBWixDQUFnQixVQUFDaUYsY0FBRCxFQUFpQmhELE1BQWpCLEVBQTRCO0FBQ2pELFlBQUlnRCxjQUFKLEVBQW9CO0FBQ2xCLGlCQUFPekYsSUFBSU0sUUFBSixDQUFhLGtCQUFiLEVBQWlDbUYsY0FBakMsQ0FBUDtBQUNEOztBQUVELGVBQU96RixJQUFJTyxXQUFKLENBQWdCLEVBQUNtRixjQUFhakQsTUFBZCxFQUFoQixDQUFQO0FBQ0QsT0FOTSxDQUFQO0FBT0QsS0FoQkEsQ0FBUDtBQW1CRCxHQWxDSSxDQUFQO0FBbUNELENBdkNEIiwiZmlsZSI6InZvdGUuanMiLCJzb3VyY2VzQ29udGVudCI6WyJ2YXIgY29uZmlnID0gcmVxdWlyZSgnL29wdC9jb2Nvcmljby9hcGktd2ViL2NvbmZpZy5qc29uJyk7XG5cbnZhciBrZXlzdG9uZSA9IHJlcXVpcmUoJ2tleXN0b25lJyk7XG52YXIgV2ViMyA9IHJlcXVpcmUoJ3dlYjMnKTtcbnZhciBhc3luYyA9IHJlcXVpcmUoJ2FzeW5jJyk7XG52YXIgbWV0YWZldGNoID0gcmVxdWlyZSgnbWV0YWZldGNoJyk7XG52YXIgZmV0Y2ggPSByZXF1aXJlKCdub2RlLWZldGNoJyk7XG52YXIgd2Vic2hvdCA9IHJlcXVpcmUoJ3dlYnNob3QnKTtcbnZhciBtZDUgPSByZXF1aXJlKCdtZDUnKTtcblxudmFyIFZvdGUgPSBrZXlzdG9uZS5saXN0KCdWb3RlJyksXG4gIFNvdXJjZSA9IGtleXN0b25lLmxpc3QoJ1NvdXJjZScpO1xuXG5leHBvcnRzLmxpc3QgPSBmdW5jdGlvbihyZXEsIHJlcykge1xuICBWb3RlLm1vZGVsLmZpbmQoKVxuICAgIC5leGVjKChlcnIsIHZvdGVzKSA9PiB7XG4gICAgICBpZiAoZXJyKVxuICAgICAgICByZXR1cm4gcmVzLmFwaUVycm9yKCdkYXRhYmFzZSBlcnJvcicsIGVycik7XG5cbiAgICAgIHJldHVybiByZXMuYXBpUmVzcG9uc2Uoe3ZvdGVzOiB2b3Rlc30pO1xuICAgIH0pO1xufVxuXG5leHBvcnRzLmdldCA9IGZ1bmN0aW9uKHJlcSwgcmVzKSB7XG4gIFZvdGUubW9kZWwuZmluZEJ5SWQocmVxLnBhcmFtcy52b3RlSWQpXG4gICAgLmV4ZWMoKGVyciwgdm90ZSkgPT4ge1xuICAgICAgaWYgKGVycilcbiAgICAgICAgcmV0dXJuIHJlcy5hcGlFcnJvcignZGF0YWJhc2UgZXJyb3InLCBlcnIpO1xuXG4gICAgICBpZiAoIXZvdGUpXG4gICAgICAgIHJldHVybiByZXMuc3RhdHVzKDQwNCkuc2VuZCgpO1xuXG4gICAgICByZXR1cm4gcmVzLmFwaVJlc3BvbnNlKHt2b3RlOiB2b3RlfSk7XG4gICAgfSk7XG59XG5cbmV4cG9ydHMuZ2V0QnlTbHVnID0gZnVuY3Rpb24ocmVxLCByZXMpIHtcbiAgVm90ZS5tb2RlbC5maW5kT25lKHtzbHVnOiByZXEucGFyYW1zLnZvdGVTbHVnfSlcbiAgICAgICAgLmV4ZWMoKGVyciwgdm90ZSkgPT4ge1xuICAgICAgICAgIGlmIChlcnIpXG4gICAgICAgICAgICByZXR1cm4gcmVzLmFwaUVycm9yKCdkYXRhYmFzZSBlcnJvcicsIGVycik7XG5cbiAgICAgICAgICBpZiAoIXZvdGUpXG4gICAgICAgICAgICByZXR1cm4gcmVzLnN0YXR1cyg0MDQpLnNlbmQoKTtcblxuICAgICAgICAgIHJldHVybiByZXMuYXBpUmVzcG9uc2Uoe3ZvdGU6IHZvdGV9KTtcbiAgICAgICAgfSk7XG59XG5cbmV4cG9ydHMuY3JlYXRlID0gZnVuY3Rpb24ocmVxLCByZXMpIHtcbiAgdmFyIGFwcCA9IHJlcS51c2VyO1xuXG4gIHZhciB1cmwgPSBkZWNvZGVVUklDb21wb25lbnQocmVxLmJvZHkudXJsKTtcbiAgaWYgKCF1cmwpIHtcbiAgICByZXR1cm4gcmVzLnN0YXR1cyg0MDApLnNlbmQoe2Vycm9yOiAnbWlzc2luZyB1cmwnfSk7XG4gIH1cblxuICB2YXIgbGFiZWxzID0gW107XG5cbiAgaWYgKHJlcS5ib2R5LmxhYmVscykge1xuICAgIHRyeSB7XG4gICAgICBsYWJlbHMgPSBKU09OLnBhcnNlKHJlcS5ib2R5LmxhYmVscyk7XG4gICAgfSBjYXRjaCAoZSkge1xuICAgICAgcmV0dXJuIHJlcy5zdGF0dXMoNDAwKS5zZW5kKHtcbiAgICAgICAgZXJyb3I6ICdpbnZhbGlkIGxhYmVscyB3aXRoIGVycm9yIFxcJycgKyBlLm1lc3NhZ2UgKyAnXFwnJyxcbiAgICAgIH0pO1xuICAgIH1cbiAgfVxuXG4gIHJldHVybiBhc3luYy53YXRlcmZhbGwoXG4gICAgW1xuICAgICAgKGNhbGxiYWNrKSA9PiAhYXBwLmlzVmFsaWRVUkwodXJsKVxuICAgICAgICA/IGNhbGxiYWNrKHtjb2RlOiA0MDMsIGVycm9yOiAnaW52YWxpZCB1cmwnfSwgbnVsbClcbiAgICAgICAgOiBWb3RlLm1vZGVsLmZpbmRPbmUoe3VybDogdXJsfSlcbiAgICAgICAgICAgIC5leGVjKChlcnIsIHZvdGUpID0+IGNhbGxiYWNrKGVyciwgdm90ZSkpLFxuICAgICAgLy8gU3RlcCAyOiBjaGVjayB0aGVyZSBpcyBubyB2b3RlIGZvciB0aGlzIFVSTCBhbmQgZmV0Y2ggbWV0YSBmaWVsZHNcbiAgICAgIC8vIGlmIHRoZXJlIGlzIG5vdC5cbiAgICAgICh2b3RlLCBjYWxsYmFjaykgPT4gISF2b3RlXG4gICAgICAgID8gY2FsbGJhY2soe2NvZGU6IDQwMCwgZXJyb3I6ICdpbnZhbGlkIHVybCd9LCBudWxsKVxuICAgICAgICA6IFZvdGUubW9kZWwoe1xuICAgICAgICAgIGFwcDogYXBwLmlkLFxuICAgICAgICAgIHVybDogdXJsLFxuICAgICAgICAgIHJlc3RyaWN0ZWQ6IHJlcS5ib2R5LnJlc3RyaWN0ZWQgPT09ICd0cnVlJyxcbiAgICAgICAgICBsYWJlbHM6IGxhYmVscyxcbiAgICAgICAgfSkuc2F2ZSgoZXJyLCB2b3RlKSA9PiBjYWxsYmFjayhlcnIsIHZvdGUpKSxcbiAgICBdLFxuICAgICAgICAoZXJyLCB2b3RlKSA9PiB7XG4gICAgICAgICAgaWYgKGVycikge1xuICAgICAgICAgICAgaWYgKGVyci5jb2RlKSB7XG4gICAgICAgICAgICAgIHJlcy5zdGF0dXMoZXJyLmNvZGUpO1xuICAgICAgICAgICAgfVxuICAgICAgICAgICAgaWYgKGVyci5lcnJvcikge1xuICAgICAgICAgICAgICByZXR1cm4gcmVzLmFwaUVycm9yKGVyci5lcnJvcik7XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICByZXR1cm4gcmVzLmFwaUVycm9yKGVycik7XG4gICAgICAgICAgfVxuICAgICAgICAgIHJldHVybiByZXMuYXBpUmVzcG9uc2Uoe3ZvdGU6IHZvdGV9KTtcbiAgICAgICAgfVxuICAgICk7XG59XG5cbmV4cG9ydHMudXBkYXRlID0gZnVuY3Rpb24ocmVxLCByZXMpIHtcbiAgdmFyIHZvdGVJZCA9IHJlcS5wYXJhbXMudm90ZUlkO1xuXG4gIFZvdGUubW9kZWwuZmluZEJ5SWQodm90ZUlkKVxuICAgIC5leGVjKChmaW5kVm90ZUVyciwgdm90ZSkgPT4ge1xuICAgICAgaWYgKGZpbmRWb3RlRXJyKVxuICAgICAgICByZXR1cm4gcmVzLmFwaUVycm9yKCdkYXRhYmFzZSBlcnJvcicsIGZpbmRWb3RlRXJyKTtcblxuICAgICAgaWYgKCF2b3RlKVxuICAgICAgICByZXR1cm4gcmVzLnN0YXR1cyg0MDQpLnNlbmQoKTtcblxuICAgICAgaWYgKHZvdGUuYXBwICE9PSByZXEudXNlci5pZCkge1xuICAgICAgICByZXR1cm4gcmVzLnN0YXR1cyg0MDMpLnNlbmQoKTtcbiAgICAgIH1cblxuICAgICAgZm9yIChwcm9wZXJ0eU5hbWUgaW4gdm90ZSkge1xuICAgICAgICBpZiAocHJvcGVydHlOYW1lIGluIHJlcS5ib2R5KSB7XG4gICAgICAgICAgdm90ZVtwcm9wZXJ0eU5hbWVdID0gcmVxLmJvZHlbcHJvcGVydHlOYW1lXTtcbiAgICAgICAgfVxuICAgICAgfVxuXG4gICAgICByZXR1cm4gdm90ZS5zYXZlKChlcnIpID0+IHtcbiAgICAgICAgaWYgKGVycilcbiAgICAgICAgICByZXR1cm4gcmVzLmFwaUVycm9yKCdkYXRhYmFzZSBlcnJvcicsIGVycik7XG5cbiAgICAgICAgcmV0dXJuIHJlcy5hcGlSZXNwb25zZSh7dm90ZTogdm90ZX0pO1xuICAgICAgfSk7XG4gICAgfSk7XG59XG5cbi8vIGV4cG9ydHMucmVzdWx0UGVyRGF0ZSA9IGZ1bmN0aW9uKHJlcSwgcmVzKSB7XG4vLyAgICAgdmFyIHZvdGVJZCA9IHJlcS5wYXJhbXMudm90ZUlkO1xuLy9cbi8vICAgICBWb3RlLm1vZGVsLmZpbmRCeUlkKHZvdGVJZClcbi8vICAgICAgICAgLmV4ZWMoKGVyciwgdm90ZSkgPT4ge1xuLy8gICAgICAgICAgICAgaWYgKGVycilcbi8vICAgICAgICAgICAgICAgICByZXR1cm4gcmVzLmFwaUVycm9yKCdkYXRhYmFzZSBlcnJvcicsIGVycik7XG4vL1xuLy8gICAgICAgICAgICAgaWYgKCF2b3RlKVxuLy8gICAgICAgICAgICAgICAgIHJldHVybiByZXMuc3RhdHVzKDQwNCkuc2VuZCgpO1xuLy9cbi8vICAgICAgICAgICAgIHJlcy5hcGlSZXNwb25zZSh7cmVzdWx0IDogbnVsbH0pO1xuLy8gICAgICAgICB9KTtcbi8vIH1cbi8vXG4vLyBleHBvcnRzLnJlc3VsdFBlckdlbmRlciA9IGZ1bmN0aW9uKHJlcSwgcmVzKSB7XG4vLyAgICAgdmFyIHZvdGVJZCA9IHJlcS5wYXJhbXMudm90ZUlkO1xuLy9cbi8vICAgICBWb3RlLm1vZGVsLmZpbmRCeUlkKHZvdGVJZClcbi8vICAgICAgICAgLmV4ZWMoKGVyciwgdm90ZSkgPT4ge1xuLy8gICAgICAgICAgICAgaWYgKGVycilcbi8vICAgICAgICAgICAgICAgICByZXR1cm4gcmVzLmFwaUVycm9yKCdkYXRhYmFzZSBlcnJvcicsIGVycik7XG4vL1xuLy8gICAgICAgICAgICAgaWYgKCF2b3RlKVxuLy8gICAgICAgICAgICAgICAgIHJldHVybiByZXMuc3RhdHVzKDQwNCkuc2VuZCgpO1xuLy9cbi8vICAgICAgICAgICAgIHJlcy5hcGlSZXNwb25zZSh7cmVzdWx0IDogbnVsbH0pO1xuLy8gICAgICAgICB9KTtcbi8vIH1cbi8vXG4vLyBleHBvcnRzLnJlc3VsdFBlckFnZSA9IGZ1bmN0aW9uKHJlcSwgcmVzKSB7XG4vLyAgICAgdmFyIHZvdGVJZCA9IHJlcS5wYXJhbXMudm90ZUlkO1xuLy9cbi8vICAgICBWb3RlLm1vZGVsLmZpbmRCeUlkKHZvdGVJZClcbi8vICAgICAgICAgLmV4ZWMoKGVyciwgdm90ZSkgPT4ge1xuLy8gICAgICAgICAgICAgaWYgKGVycilcbi8vICAgICAgICAgICAgICAgICByZXR1cm4gcmVzLmFwaUVycm9yKCdkYXRhYmFzZSBlcnJvcicsIGVycik7XG4vL1xuLy8gICAgICAgICAgICAgaWYgKCF2b3RlKVxuLy8gICAgICAgICAgICAgICAgIHJldHVybiByZXMuc3RhdHVzKDQwNCkuc2VuZCgpO1xuLy9cbi8vICAgICAgICAgICAgIHJlcy5hcGlSZXNwb25zZSh7cmVzdWx0IDogbnVsbH0pO1xuLy8gICAgICAgICB9KTtcbi8vIH1cblxuZXhwb3J0cy5yZXN1bHQgPSBmdW5jdGlvbihyZXEsIHJlcykge1xuICB2YXIgdm90ZUlkID0gcmVxLnBhcmFtcy52b3RlSWQ7XG5cbiAgVm90ZS5tb2RlbC5maW5kQnlJZCh2b3RlSWQpXG4gICAgLmV4ZWMoKGZpbmRWb3RlRXJyLCB2b3RlKSA9PiB7XG4gICAgICBpZiAoZmluZFZvdGVFcnIpXG4gICAgICAgIHJldHVybiByZXMuYXBpRXJyb3IoJ2RhdGFiYXNlIGVycm9yJywgZmluZFZvdGVFcnIpO1xuXG4gICAgICBpZiAoIXZvdGUpXG4gICAgICAgIHJldHVybiByZXMuc3RhdHVzKDQwNCkuc2VuZCgpO1xuXG4gICAgICB2YXIgd2ViMyA9IG5ldyBXZWIzKCk7XG4gICAgICB3ZWIzLnNldFByb3ZpZGVyKG5ldyB3ZWIzLnByb3ZpZGVycy5IdHRwUHJvdmlkZXIoXG4gICAgICAgICdodHRwOi8vMTI3LjAuMC4xOjg1NDUnXG4gICAgICApKTtcblxuICAgICAgcmV0dXJuIHdlYjMuZXRoLmNvbnRyYWN0KEpTT04ucGFyc2Uodm90ZS52b3RlQ29udHJhY3RBQkkpKS5hdChcbiAgICAgICAgdm90ZS52b3RlQ29udHJhY3RBZGRyZXNzLFxuICAgICAgICAoZXJyLCB2b3RlSW5zdGFuY2UpID0+IHJlcy5hcGlSZXNwb25zZShcbiAgICAgICAgICB7cmVzdWx0IDogdm90ZUluc3RhbmNlLmdldFZvdGVSZXN1bHRzKCkubWFwKChzKSA9PiBwYXJzZUludChzKSl9XG4gICAgICAgIClcbiAgICAgICk7XG4gICAgfSk7XG59XG5cbmV4cG9ydHMuZW1iZWQgPSBmdW5jdGlvbihyZXEsIHJlcykge1xuICBpZiAoIXJlcS5oZWFkZXJzLnJlZmVyZXIpIHtcbiAgICByZXR1cm4gcmVzLnN0YXR1cyg0MDApLnNlbmQoe2Vycm9yIDogJ21pc3NpbmcgcmVmZXJlcid9KTtcbiAgfVxuXG4gIHJldHVybiBhc3luYy53YXRlcmZhbGwoXG4gICAgW1xuICAgICAgKGNhbGxiYWNrKSA9PiBWb3RlLm1vZGVsLmZpbmRCeUlkKHJlcS5wYXJhbXMudm90ZUlkKS5leGVjKGNhbGxiYWNrKSxcbiAgICAgICh2b3RlLCBjYWxsYmFjaykgPT4gIXZvdGVcbiAgICAgICAgPyBjYWxsYmFjayh7Y29kZTogNDA0LCBtc2c6ICd2b3RlIG5vdCBmb3VuZCd9LCBudWxsKVxuICAgICAgICA6IGNhbGxiYWNrKG51bGwsIHZvdGUpLFxuICAgICAgICAvLyBTdGVwIDA6IGZldGNoIHRoZSBwYWdlIG1ldGEgdG8gZ2V0IHRoZSB1bmlxdWUgVVJMXG4gICAgICAodm90ZSwgY2FsbGJhY2spID0+IG1ldGFmZXRjaC5mZXRjaChcbiAgICAgICAgcmVxLmhlYWRlcnMucmVmZXJlcixcbiAgICAgICAge1xuICAgICAgICAgIGZsYWdzOiB7IGltYWdlczogZmFsc2UsIGxpbmtzOiBmYWxzZSB9LFxuICAgICAgICAgIGh0dHA6IHsgdGltZW91dDogMzAwMDAgfSxcbiAgICAgICAgfSxcbiAgICAgICAgKGVyciwgbWV0YSkgPT4gY2FsbGJhY2soZXJyLCB2b3RlLCBtZXRhKVxuICAgICAgKSxcbiAgICAgIC8vIFN0ZXAgMTogZmluZCB0aGUgY29ycmVzcG9uZGluZyBTb3VyY2VcbiAgICAgICh2b3RlLCBtZXRhLCBjYWxsYmFjaykgPT4gU291cmNlLm1vZGVsLmZpbmRPbmUoe3VybDogbWV0YS51cmx9KVxuICAgICAgICAuZXhlYygoZXJyLCBzb3VyY2UpID0+IGNhbGxiYWNrKGVyciwgdm90ZSwgbWV0YSwgc291cmNlKSksXG4gICAgICAvLyBTdGVwIDI6IGNvbnRpbnVlIGlmIHRoZSBzb3VyY2UgZG9lcyBub3QgZXhpc3RcbiAgICAgICh2b3RlLCBtZXRhLCBzb3VyY2UsIGNhbGxiYWNrKSA9PiAhIXNvdXJjZVxuICAgICAgICA/IGNhbGxiYWNrKHtjb2RlOiA0MDAsIG1zZzogJ2FscmVhZHkgbGlzdGVkJ30sIG51bGwpXG4gICAgICAgIDogY2FsbGJhY2sobnVsbCwgdm90ZSwgbWV0YSwgc291cmNlKSxcbiAgICAgIC8vIFN0ZXAgMzogZmV0Y2ggdGhlIGNvbnRlbnQgb2YgdGhlIHBhZ2UgdG8gY2hlY2sgdGhhdCB0aGUgdm90ZVxuICAgICAgLy8gYnV0dG9uIGVtYmVkIGNvZGUgaXMgcHJlc2VudFxuICAgICAgKHZvdGUsIG1ldGEsIHNvdXJjZSwgY2FsbGJhY2spID0+IGZldGNoKG1ldGEudXJsKVxuICAgICAgICAudGhlbigoZmV0Y2hSZXMpID0+IHtcbiAgICAgICAgICBpZiAoIWZldGNoUmVzLm9rIHx8IGZldGNoUmVzLnN0YXR1cyAhPT0gMjAwKSB7XG4gICAgICAgICAgICByZXR1cm4gY2FsbGJhY2soe2NvZGU6IDQwMCwgbXNnOiAndW5hYmxlIHRvIGZldGNoIHBhZ2UnfSwgbnVsbCk7XG4gICAgICAgICAgfVxuICAgICAgICAgIGlmIChmZXRjaFJlcy5oZWFkZXJzLmdldCgnY29udGVudC10eXBlJykuaW5kZXhPZigndGV4dC9odG1sJykgPCAwKSB7XG4gICAgICAgICAgICByZXR1cm4gY2FsbGJhY2soe2NvZGU6IDQwMCwgbXNnOiAnaW52YWxpZCBjb250ZW50IHR5cGUnfSwgbnVsbCk7XG4gICAgICAgICAgfVxuXG4gICAgICAgICAgcmV0dXJuIGZldGNoUmVzLnRleHQoKTtcbiAgICAgICAgfSlcbiAgICAgICAgLnRoZW4oKGh0bWwpID0+IHtcbiAgICAgICAgICAgIC8vIEZJWE1FOiBjaGVjayB0aGUgYWN0dWFsIHZvdGUgYnV0dG9uIGVtYmVkIGJ1dHRvblxuICAgICAgICAgIGlmIChodG1sLmluZGV4T2YoJzxpZnJhbWUnKSA8IDApIHtcbiAgICAgICAgICAgIHJldHVybiBjYWxsYmFjayh7Y29kZTogNDAwLCBtc2c6ICdtaXNzaW5nIGVtYmVkIGNvZGUnfSk7XG4gICAgICAgICAgfVxuXG4gICAgICAgICAgaWYgKCFtZXRhLmltYWdlKSB7XG4gICAgICAgICAgICB2YXIgZmlsZW5hbWUgPSBtZDUobWV0YS51cmwpICsgJy5qcGcnO1xuICAgICAgICAgICAgcmV0dXJuIHdlYnNob3QoXG4gICAgICAgICAgICAgIG1ldGEudXJsLFxuICAgICAgICAgICAgICAnL3ZhZ3JhbnQvYXBwL3B1YmxpYy9pbWcvc2NyZWVuc2hvdCcgKyBmaWxlbmFtZSxcbiAgICAgICAgICAgICAgKGVycikgPT4ge1xuICAgICAgICAgICAgICAgIGlmICghZXJyKSB7XG4gICAgICAgICAgICAgICAgICBtZXRhLmltYWdlID0gZmlsZW5hbWU7XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgIHJldHVybiBjYWxsYmFjayhlcnIsIHZvdGUsIG1ldGEsIHNvdXJjZSk7XG4gICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICk7XG4gICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgIHJldHVybiBjYWxsYmFjayhudWxsLCB2b3RlLCBtZXRhLCBzb3VyY2UpO1xuICAgICAgICAgIH1cbiAgICAgICAgfSksXG4gICAgICAodm90ZSwgbWV0YSwgc291cmNlLCBjYWxsYmFjaykgPT4gU291cmNlLm1vZGVsKHtcbiAgICAgICAgdXJsOiBtZXRhLnVybCxcbiAgICAgICAgdm90ZTogdm90ZSxcbiAgICAgICAgdGl0bGU6IG1ldGEudGl0bGUsXG4gICAgICAgIGRlc2NyaXB0aW9uOiBtZXRhLmRlc2NyaXB0aW9uLFxuICAgICAgICB0eXBlOiBtZXRhLnR5cGUsXG4gICAgICAgIGltYWdlOiBtZXRhLmltYWdlLFxuICAgICAgfSkuc2F2ZShjYWxsYmFjayksXG4gICAgXSxcbiAgICAgIChlcnIsIHNvdXJjZSkgPT4ge1xuICAgICAgICBpZiAoZXJyKSB7XG4gICAgICAgICAgaWYgKGVyci5jb2RlKSB7XG4gICAgICAgICAgICByZXMuc3RhdHVzKGVyci5jb2RlKTtcbiAgICAgICAgICAgIGlmIChlcnIubXNnKSB7XG4gICAgICAgICAgICAgIHJldHVybiByZXMuc2VuZCh7ZXJyb3IgOiBlcnIubXNnfSk7XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICByZXR1cm4gcmVzLnNlbmQoKTtcbiAgICAgICAgICB9XG4gICAgICAgICAgcmV0dXJuIHJlcy5hcGlFcnJvcihlcnIpO1xuICAgICAgICB9XG4gICAgICAgIHJldHVybiByZXMuYXBpUmVzcG9uc2Uoe3NvdXJjZTogc291cmNlfSk7XG4gICAgICB9XG4gICAgKTtcbn1cblxuZXhwb3J0cy5wZXJtaXNzaW9ucyA9IGZ1bmN0aW9uKHJlcSwgcmVzKSB7XG4gIHZhciB2b3RlSWQgPSByZXEucGFyYW1zLnZvdGVJZDtcblxuICBWb3RlLm1vZGVsLmZpbmRCeUlkKHZvdGVJZClcbiAgICAgICAgLmV4ZWMoKGVyciwgdm90ZSkgPT4ge1xuICAgICAgICAgIGlmIChlcnIpIHtcbiAgICAgICAgICAgIHJldHVybiByZXMuYXBpRXJyb3IoJ2RhdGFiYXNlIGVycm9yJywgZXJyKTtcbiAgICAgICAgICB9XG5cbiAgICAgICAgICBpZiAoIXZvdGUpIHtcbiAgICAgICAgICAgIHJldHVybiByZXMuc3RhdHVzKDQwNCkuc2VuZCgpO1xuICAgICAgICAgIH1cblxuICAgICAgICAgIHJldHVybiByZXMuYXBpUmVzcG9uc2Uoe1xuICAgICAgICAgICAgcGVybWlzc2lvbnMgOiB7XG4gICAgICAgICAgICAgIHJlYWQ6IGNvbmZpZy5jYXBhYmlsaXRpZXMudm90ZS5yZWFkLFxuICAgICAgICAgICAgICB2b3RlOiAhIXJlcS51c2VyICYmIHZvdGUudXNlcklzQXV0aG9yaXplZFRvVm90ZShyZXEudXNlciksXG4gICAgICAgICAgICAgIHVwZGF0ZTogY29uZmlnLmNhcGFiaWxpdGllcy52b3RlLnVwZGF0ZSxcbiAgICAgICAgICAgIH0sXG4gICAgICAgICAgfSk7XG4gICAgICAgIH0pO1xufVxuXG5leHBvcnRzLmdldFRyYW5zYWN0aW9ucyA9IGZ1bmN0aW9uKHJlcSwgcmVzKSB7XG5cbiAgdmFyIHZvdGVJZCA9IHJlcS5wYXJhbXMudm90ZUlkO1xuXG4gIHJldHVybiBWb3RlLm1vZGVsLmZpbmRCeUlkKHZvdGVJZClcbiAgICAuZXhlYygoZXJyLCB2b3RlKSA9PiB7XG4gICAgICBpZiAoZXJyKSB7XG4gICAgICAgIHJldHVybiByZXMuYXBpRXJyb3IoJ2RhdGFiYXNlIGVycm9yJywgZXJyKTtcbiAgICAgIH1cblxuICAgICAgaWYgKCF2b3RlKSB7XG4gICAgICAgIHJldHVybiByZXMuc3RhdHVzKDQwNCkuc2VuZCgpO1xuICAgICAgfVxuXG4gICAgICAvLyBGSVhNRTogQWRkIDQwMyBpZiB2b3RlLnN0YXR1cyAhPSBjb21wbGV0ZVxuXG4gICAgICB2YXIgd2ViMyA9IG5ldyBXZWIzKCk7XG4gICAgICB3ZWIzLnNldFByb3ZpZGVyKG5ldyB3ZWIzLnByb3ZpZGVycy5IdHRwUHJvdmlkZXIoJ2h0dHA6Ly8xMjcuMC4wLjE6ODU0NScpKTtcblxuICAgICAgcmV0dXJuIHdlYjMuZXRoLmNvbnRyYWN0KEpTT04ucGFyc2Uodm90ZS52b3RlQ29udHJhY3RBQkkpKVxuICAgICAgICAuYXQoXG4gICAgICAgICAgICB2b3RlLnZvdGVDb250cmFjdEFkZHJlc3MsXG4gICAgICAgICAgICAoYXRFcnIsIGluc3RhbmNlKSA9PiB7XG4gICAgICAgICAgICAgIGlmIChhdEVycikge1xuICAgICAgICAgICAgICAgIHJldHVybiByZXMuYXBpRXJyb3IoJ2Jsb2NrY2hhaW4gZXJyb3InLCBhdEVycik7XG4gICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICB2YXIgYmFsbG90RXZlbnQgPSBpbnN0YW5jZS5CYWxsb3QobnVsbCwge2Zyb21CbG9jazowLCB0b0Jsb2NrOiAnbGF0ZXN0J30pO1xuICAgICAgICAgICAgICByZXR1cm4gYmFsbG90RXZlbnQuZ2V0KChiYWxsb3RFdmVudEVyciwgcmVzdWx0KSA9PiB7XG4gICAgICAgICAgICAgICAgaWYgKGJhbGxvdEV2ZW50RXJyKSB7XG4gICAgICAgICAgICAgICAgICByZXR1cm4gcmVzLmFwaUVycm9yKCdibG9ja2NoYWluIGVycm9yJywgYmFsbG90RXZlbnRFcnIpO1xuICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgIHJldHVybiByZXMuYXBpUmVzcG9uc2Uoe3RyYW5zYWN0aW9uczpyZXN1bHR9KTtcbiAgICAgICAgICAgICAgfSk7XG4gICAgICAgICAgICB9XG4gICAgICAgICk7XG5cbiAgICB9KTtcbn1cbiJdfQ==