#!/bin/sh

# Start by loading certs
/reload-certs.sh

# start supervisord 
supervisord -n -c /etc/supervisord/supervisord.conf

