#!/bin/sh
set -uf -o pipefail

export POSTGRES_USER=postgres
export PAYMENT_MANAGER_CONNECTION=postgresql://postgres@localhost/payer 

dropdb --if-exists payer
dropdb --if-exists receipt
createdb -U $POSTGRES_USER payer
createdb -U $POSTGRES_USER receipt

(
  cd ../payments
  yarn db:create_schema
)
yarn test