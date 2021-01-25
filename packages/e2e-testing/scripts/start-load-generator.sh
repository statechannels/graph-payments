#!/bin/sh

yarn nodemon --watch 'src/**/*.ts' --ignore 'src/**/*.test.ts' --exec 'time ts-node' src/load-generator.ts