#!/usr/bin/env node
// const logger = require('loggy');
// process.on('unhandledRejection', err => { throw err; });
// process.on('SIGINT', () => process.exit());
// process.on('SIGTERM', () => process.exit());
// process.on('exit', () => process.exit(logger.errorHappened ? 1 : 0));

require('dotenv');

const http = require('http');

const bodyParser = require('body-parser');
const express = require('express');
const deepAssign = require('deep-assign');
const fetchManifest = require('fetch-manifest').fetchManifest;
// const GithubDB = require('github-db').default;
const resourceRouter = require('resource-router-middleware');
const clipboardy = require('clipboardy');
const cors = require('cors');
const morgan = require('morgan');

const pkgJson = require('./package.json');
const settingsDefault = require('./settings.js');
let settings = settingsDefault;
try {
  settings = deepAssign(settingsDefault, require('./settings_local.js'));
} catch (e) {
}

// const ghDBOptions = {
//   user: 'aframevr-userland',
//   repo: 'aframe-index-db',
//   remoteFilename: 'index.json'
// };

// const githubDB = new GithubDB(ghDBOptions);

// function auth () {
//   // Token generated from here: https://github.com/settings/tokens
//   githubDB.auth(process.env.GH_TOKEN);
//   githubDB.connectToRepo();
// }

const app = express();
app.server = http.createServer(app);

app.use(morgan('dev'));

app.use(cors());

app.use(express.static('public'));

app.use(bodyParser.json());

/**
 * Creates a callback that proxies node callback style arguments to an Express
 * `Response` object.
 *	@param {express.Response} res	Express HTTP Response
 *	@param {number} [status=200]	Status code to send on success
 *
 *	@example
 *		list (req, res) {
 *			collection.find({}, toRes(res));
 *		}
 */
const toRes = (res, status=200) => {
	return (err, item) => {
		if (err) {
      return res.status(500).send(err);
    }

		if (item && typeof item.toObject === 'function') {
			item = item.toObject();
		}

		res.status(status).json(item);
	};
};

const utils = {
  isStrANumber: num => !isNaN(num),
  getTitleCasedStr: str => {
    let mediaType = (str || '');
    return mediaType.charAt(0).toUpperCase() + mediaType.substr(1).toLowerCase();
  }
};

const rootObj = ({ pkg, settings }) => {
  const apiVersion = parseInt(pkg.apiVersion || pkg.version || '0');
  return {
    status: 'ok',
    version: apiVersion,
    manifests_url: `${settings.baseUrl}/api/manifests`,
    // scene_url: `${settings.baseUrl}{/owner}{/scene_slug}`,
  };
};

const apiRoot = (req, res) => {
  res.json(rootObj({pkg: pkgJson, settings: settings}));
};

let manifests = [];
let works = [];
let worksByManifestUrl = {};

const apiManifests = ({settings}) => resourceRouter({
	/** Property name to store preloaded entity on `request`. */
	id: 'manifest',

	/**
   * For requests with an `id`, you can auto-load the entity.
	 * Errors terminate the request; successes set `req[id] = data`.
	 */
	load (req, id, callback) {
		let manifest = manifests.find(manifest => manifest._id === id);
		let err = manifest ? null : 'Not found';
    if (typeof callback === 'function') {
		  callback(err, manifest);
    }
	},

	/** GET / - List all entities. */
	index ({params}, res) {
		res.json(manifests);
	},

	/** POST / - Create a new entity. */
	create ({body}, res) {
    let manifestOrUrl = body;

    const numKeys = Object.keys(body);
    if (!numKeys.length) {
      toRes(res, 400)({
        error: true,
        name: 'Bad Request',
        message: 'Required: a `url` parameter or a manifest as a JSON blob'
      }, body);
      return;
    }

    if (numKeys.length < 3) {
      manifestOrUrl = (body.url || body.manifest_url || body.site_url || '').trim();
    }

    return fetchManifest(manifestOrUrl).then(manifest => {
      const dateFetched = new Date();

      if (!manifest._id) {
        manifest._id = (manifests.length + 1).toString(36);
      }

      manifest._date_fetched_milliseconds = dateFetched.getTime();
      manifest._date_fetched_iso = dateFetched.toISOString();
      manifest._date_fetched_locale_string = dateFetched.toLocaleString();
      manifest._date_fetched_locale_en_US_full = dateFetched.toLocaleString('en-US', {
        weekday: 'short',
        year: 'numeric',
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit'
      });
      manifest._date_fetched_locale_en_US_full_without_weekday = dateFetched.toLocaleString('en-US', {
        year: 'numeric',
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit'
      });
      manifest._date_fetched_locale_en_US_date = dateFetched.toLocaleString('en-US', {
        weekday: 'short',
        year: 'numeric',
        month: 'short',
        day: 'numeric'
      });
      manifest._date_fetched_locale_en_US_date_without_weekday = dateFetched.toLocaleString('en-US', {
        year: 'numeric',
        month: 'short',
        day: 'numeric'
      });
      manifest._date_fetched_locale_en_US_time = dateFetched.toLocaleString('en-US', {
        hour: '2-digit',
        minute: '2-digit'
      });

      manifest._date_fetched = manifest._date_fetched_locale_en_US_full;

      manifest._work_type = utils.getTitleCasedStr(manifest['@type'] || manifest.type || 'Site');

      let work = {};

      if (manifest.processed_final_manifest_url in worksByManifestUrl) {
        work = works.find((work, idx) => {
          const isFound = work._id === manifest._work_id;
          if (isFound) {
            works[idx] = manifest;
            return true;
          }
        });
      } else {
        if (!manifest._work_id) {
          manifest._work_id = (works.length + 1).toString(36);
        }
        work = manifest;

        work = deepAssign({}, manifest, {
          _id: manifest._work_id,
          _manifest_id: manifest._id
        });
        delete work._work_id;

        works.push(work);

      }

      worksByManifestUrl[manifest.processed_final_manifest_url] = work;

      manifests.push(manifest);

      res.json(manifest);
    }).catch(err => {
      console.warn(err);
      toRes(res, 500)({
        error: true,
        name: 'Internal Server Error',
        message: 'Could not fetch web-app manifest data'
      }, body);
    });
	},

	/** GET /:id - Return a given entity. */
	read ({manifest}, res) {
		res.json(manifest);
	},

	/** PUT /:id - Update a given entity. */
	update ({manifest, body}, res) {
		Object.keys(body).forEach(key => {
      if (key === 'id' || key.charAt(0) === '_') {
        return;
      }
			manifest[key] = body[key];
      worksByManifestUrl[manifest.processed_final_manifest_url] = body[key];
		});
		res.sendStatus(204);
	},

	/** DELETE /:id - Delete a given entity. */
	delete({manifest}, res) {
		manifests.splice(manifests.indexOf(manifest), 1);
    delete worksByManifestUrl[manifest.processed_final_manifest_url];
		res.sendStatus(204);
	}
});

const apiWorks = ({settings}) => resourceRouter({
	/** Property name to store preloaded entity on `request`. */
	id: 'work',

	/**
   * For requests with an `id`, you can auto-load the entity.
	 * Errors terminate the request; successes set `req[id] = data`.
	 */
	load (req, id, callback) {
    let work;

    // if (typeof id === 'string' && !utils.isStrANumber(id)) {
    //   const manifestUrl = id.trim();
    //   work = worksByManifestUrl[manifestUrl];
    // } else {
      work = works.find(work => work._id === id);
    // }

		let err = work ? null : 'Not found';
    if (typeof callback === 'function') {
		  callback(err, work);
    }
	},

	/** GET / - List all entities. */
	index ({params}, res) {
		res.json(works);
	},

	/** POST / - Create a new entity. */
	create ({body}, res) {
    toRes(res, 400)({
      error: true,
      name: 'Bad Request',
      message: 'This is a read-only endpoint (you must submit new works ' +
               'using the respective API endpoint defined at `manifests_url`)'
    }, body);
	},

	/** GET /:id - Return a given entity. */
	read ({work}, res) {
		res.json(work);
	},

	/** PUT /:id - Update a given entity. */
	update ({work, body}, res) {
    toRes(res, 400)({
      error: true,
      name: 'Bad Request',
      message: 'This is a read-only endpoint (you must submit new works ' +
               'using the respective API endpoint defined at `manifests_url`)'
    }, body);
	},

	/** DELETE /:id - Delete a given entity. */
	delete({work}, res) {
    toRes(res, 400)({
      error: true,
      name: 'Bad Request',
      message: 'This is a read-only endpoint (you must submit new works ' +
               'using the respective API endpoint defined at `manifests_url`)'
    });
	}
});

const api = settings => {
  let api = express.Router();
  api.use('/manifests', apiManifests({settings}));
  api.use('/works', apiWorks({settings}));
  api.get('/', apiRoot);
  return api;
};

app.use('/api', api({settings}));
app.get('/', apiRoot);

if (!settings.baseUrl && app.get('env') === 'production') {
  settings.baseUrl = 'https://api.index.aframe.io';
}

if (!module.parent) {
  const listener = app.server.listen(settings.port, settings.host, () => {
    if (!settings.baseUrl && app.get('env') === 'development') {
      const serverHost = listener.address().address;
      const serverPort = listener.address().port;
      settings.baseUrl = `http://${serverHost}:${serverPort}`;
    }
    console.log('Listening on %s', settings.baseUrl);
    clipboardy.writeSync(settings.baseUrl);
  });
  module.exports.listener = listener;
}

module.exports.settings = settings;
module.exports.app = app;
module.exports.server = app.server;
