#!/bin/sh
# For developer convenience, this reloads on filesave.
# This makes it easier to prototype changes to the payment-server
# Restarting the script is a kind of a "factory-reset", since it will also delete and re-create the database
set -uf -o pipefail

export POSTGRES_USER=postgres
export LOGFILE=$1

dropdb --if-exists payer
dropdb --if-exists receipt
createdb -U $POSTGRES_USER payer
createdb -U $POSTGRES_USER receipt

cd ../payments
yarn db:create_schema postgresql://postgres@localhost/payer 
cd ../e2e-testing

# Uncomment the following for non-reloading prototyping
# Please refrain from checking in comment changes, 

# yarn ts-node src/payment-server.ts listen \
#   --logFile $LOGFILE \
#   --numAllocations 2 \
#   --channelsPerAllocation 60 \
#   --meanDelay: 10

yarn nodemon --watch 'src/**/*.ts' --ignore 'src/**/*.test.ts' --exec 'ts-node' src/payment-server.ts listen \
  --logFile $LOGFILE