#!/bin/sh
set -uf -o pipefail

export POSTGRES_USER=postgres

dropdb --if-exists payer
dropdb --if-exists receipt
createdb -U $POSTGRES_USER payer
createdb -U $POSTGRES_USER receipt

cd ../payments
yarn db:create_schema postgresql://postgres@localhost/payer 
cd ../e2e-testing
yarn test