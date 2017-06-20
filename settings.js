const NODE_ENV = process.env.NODE_ENV || 'development';

let settings = {
  host: process.env.AFRAME_INDEX_API_HOST || process.env.HOST || '0.0.0.0',
  port: process.env.AFRAME_INDEX_API_PORT || process.env.PORT || 3000
};

if (NODE_ENV === 'production') {
  settings.baseUrl = 'https://index-api.aframe.io';
}

module.exports = settings;
