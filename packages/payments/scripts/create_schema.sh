#!/bin/sh
psql -Atx $PAYMENT_MANAGER_CONNECTION -c 'CREATE SCHEMA IF NOT EXISTS payment_manager'