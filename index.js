#!/usr/bin/env node
process.on('unhandledRejection', err => { throw err; });

require('dotenv').config();

const http = require('http');

const bodyParser = require('body-parser');
const express = require('express');
const deepAssign = require('deep-assign');
const fetchManifest = require('fetch-manifest').fetchManifest;
const GithubDB = require('github-db').default;
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

const ALLOWED_COLLECTIONS = {
  manifests: 'manifests.json',
  works: 'works.json'
};
const DEFAULT_BASE_URL = 'https://api.index.aframe.io';

const app = express();
app.server = http.createServer(app);

app.use(morgan('dev'));

app.use(cors());

app.use(express.static('public'));

app.use(bodyParser.json());

// Source: This method and the outline of the routes defined below are adapted
// from https://github.com/developit/express-es6-rest-api
/**
 * Creates a callback that proxies node callback style arguments to an Express
 * `Response` object.
 * @param {express.Response} res  Express HTTP Response
 * @param {number} [status=200]  Status code to send on success
 *
 * @example
 *   list (req, res) {
 *     collection.find({}, toRes(res));
 *   }
 */
const toRes = (res, status = 200) => {
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

const persist = (collectionName, data, idx) => {
  collectionName = (collectionName || '').trim().toLowerCase().replace(/\..+/, '');

  console.log('Persisting "%s"', collectionName);

  if (!(collectionName in ALLOWED_COLLECTIONS)) {
    return Promise.resolve(false);
  }

  const collectionPath = ALLOWED_COLLECTIONS[collectionName];

  const options = {
    owner: 'aframevr-userland',
    repo: 'aframe-index-snapshot',
    path: collectionPath
  };

  const githubDB = new GithubDB(options);

  function auth () {
    // Token generated from here: https://github.com/settings/tokens
    githubDB.auth(process.env.GH_TOKEN);
    return githubDB.connectToRepo();
  }

  return auth().then(() => {
    if (idx) {
      return githubDB.update({_idx: idx}, data, {
        multi: true,
        upsert: true
      });
    } else {
      return githubDB.save(data);
    }
  }, err => {
    console.log('Failed to authenticate to GitHub repo `%s/%s`:',
      options.owner, options.repo, err || '(Unknown error)');
  })
  .then(() => {
    console.log('Successfully persisted "%s" data to GitHub repo `%s/%s`',
      options.path, options.owner, options.repo);
    return Promise.resolve(true);
  }).catch(err => {
    console.log('Failed to persist data to GitHub repo `%s/%s`:',
      options.path, options.owner, options.repo, err || '(Unknown error)');
  });
};

const load = (collectionName, data, idx) => {
  let queryFilter = {};

  if (typeof idx !== 'undefined') {
    if (typeof idx === 'object') {
      queryFilter = idx;
    } else {
      queryFilter = {_idx: String(idx)};
    }
  }

  collectionName = (collectionName || '').trim().toLowerCase().replace(/\..+/, '');

  console.log('Loading "%s"', collectionName);

  if (!(collectionName in ALLOWED_COLLECTIONS)) {
    return Promise.resolve(false);
  }

  const collectionPath = ALLOWED_COLLECTIONS[collectionName];

  const options = {
    owner: 'aframevr-userland',
    repo: 'aframe-index-snapshot',
    path: collectionPath
  };

  const githubDB = new GithubDB(options);

  function auth () {
    // Token generated from here: https://github.com/settings/tokens
    githubDB.auth(process.env.GH_TOKEN);
    return githubDB.connectToRepo();
  }

  return auth().then(() => {
    return githubDB.find(queryFilter)
    .then(results => {
      console.log('Successfully loaded "%s" data from GitHub repo `%s/%s`',
        options.path, options.owner, options.repo);
      if (typeof results !== 'object') {
        try {
          results = JSON.parse(results);
        } catch (e) {
        }
      }
      return Promise.resolve(results);
    }).catch(err => {
      console.log('Failed to load data from GitHub repo `%s/%s`:',
        options.path, options.owner, options.repo, err || '(Unknown error)');
    });
  }, err => {
    console.log('Failed to authenticate to GitHub repo `%s/%s`:',
      options.owner, options.repo, err || '(Unknown error)');
  });
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
    works_url: `${settings.baseUrl}/api/works`
  };
};

const apiRoot = (req, res) => {
  res.json(rootObj({pkg: pkgJson, settings: settings}));
};

let manifestsByManifestUrl = {};
let worksByManifestUrl = {};
let manifests = [];
let works = [];

load('manifests').then(results => {
  manifests = results;
  manifests.forEach(manifest => {
    if (!manifest.processed_final_manifest_url) {
      return;
    }
    manifestsByManifestUrl[manifest.processed_final_manifest_url] = manifest;
  });
});

load('works').then(results => {
  works = results;
  works.forEach(work => {
    if (!work.processed_final_manifest_url) {
      return;
    }
    worksByManifestUrl[work.processed_final_manifest_url] = work;
  });
});

const apiManifests = ({settings}) => resourceRouter({
  /** Property name to store preloaded entity on `request`. */
  id: 'manifest',

  /**
   * For requests with an `idx`, you can auto-load the entity.
   * Errors terminate the request; successes set `req[idx] = data`.
   */
  load (req, idx, callback) {
    let manifest = manifests.find(manifest => manifest._idx === idx);
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

      if (!manifest._idx) {
        manifest._idx = String(manifests.length + 1);
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

      let work;
      let worksArrayIdxToUpdate = -1;

      if (manifest.processed_final_manifest_url in worksByManifestUrl) {
        manifest._work_idx = worksByManifestUrl[manifest.processed_final_manifest_url]._idx;
      } else {
        manifest._work_idx = String(works.length + 1);
      }

      works.find((work, idx) => {
        if (work._idx === manifest._work_idx) {
          worksArrayIdxToUpdate = idx;
          return true;
        }
      });

      work = deepAssign({}, manifest, {
        _idx: manifest._work_idx,
        _manifest_idx: manifest._idx
      });
      delete work._work_idx;

      if (worksArrayIdxToUpdate > -1) {
        works[worksArrayIdxToUpdate] = work;
      } else {
        works.push(work);
      }

      manifestsByManifestUrl[manifest.processed_final_manifest_url] = manifest;

      worksByManifestUrl[manifest.processed_final_manifest_url] = work;

      manifests.push(manifest);

      res.json(manifest);

      return persist('manifests', manifests).then(() => new Promise((resolve, reject) => {
        setTimeout(() => {
          if (work) {
            return persist('works', work, work._idx).then(resolve, reject);
          }
          resolve(false);
        }, 3000);
      }));
    }, err => {
      console.warn(err);
      toRes(res, 500)({
        error: true,
        name: 'Internal Server Error',
        message: 'Could not fetch web-app manifest data'
      }, body);
    }).catch(err => {
      console.warn(err);
      toRes(res, 500)({
        error: true,
        name: 'Internal Server Error',
        message: 'Could not submit manifest'
      }, body);
    });
  },

  /** GET /:id - Return a given entity. */
  read ({manifest}, res) {
    res.json(manifest);
  },

  /** PUT /:id - Update a given entity. */
  update ({manifest, body}, res) {
    // TODO: Persist updates to snapshot repository on GitHub.
    Object.keys(body).forEach(key => {
      if (key === 'id' || key.charAt(0) === '_') {
        return;
      }
      manifest[key] = body[key];
    });
    manifestsByManifestUrl[manifest.processed_final_manifest_url] = manifest;
    worksByManifestUrl[manifest.processed_final_manifest_url] = manifest;
    res.sendStatus(204);
  },

  /** DELETE /:id - Delete a given entity. */
  delete ({manifest}, res) {
    // TODO: Persist deletions to snapshot repository on GitHub.
    manifests.splice(manifests.indexOf(manifest), 1);
    works = works.forEach((work, idx) => {
      if (manifest._work_idx && work._idx === manifest._work_idx) {
        works.splice(works.indexOf(work), 1);
      }
    });
    delete manifestsByManifestUrl[manifest.processed_final_manifest_url];
    delete worksByManifestUrl[manifest.processed_final_manifest_url];
    res.sendStatus(204);
  }
});

const apiWorks = ({settings}) => resourceRouter({
  /** Property name to store preloaded entity on `request`. */
  id: 'work',

  /**
   * For requests with an `idx`, you can auto-load the entity.
   * Errors terminate the request; successes set `req[idx] = data`.
   */
  load (req, idx, callback) {
    let work;

    if (typeof idx === 'string' && !utils.isStrANumber(idx)) {
      const manifestUrl = idx.trim();
      work = worksByManifestUrl[manifestUrl];
    } else {
      work = works.find(work => work._idx === idx);
    }

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
  delete ({work}, res) {
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
  settings.baseUrl = DEFAULT_BASE_URL;
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
