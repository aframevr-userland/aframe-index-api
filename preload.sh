#!/bin/sh

# Submit manifest for `A-Painter`.
curl -X POST -H "Content-Type: application/json" -d '{"url": "https://aframe.io/a-painter"}' "http://0.0.0.0:3000/api/manifests"

# Submit manifest for `A-Saturday-Night`.
curl -X POST -H "Content-Type: application/json" -d '{"url": "https://aframe.io/a-saturday-night/"}' "http://0.0.0.0:3000/api/manifests"
