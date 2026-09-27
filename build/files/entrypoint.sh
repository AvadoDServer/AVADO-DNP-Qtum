#!/bin/sh

# Start by loading certs
/reload-certs.sh

# start supervisord as PID 1 so that "docker stop" reaches it and it can stop
# qtumd cleanly
exec supervisord -n -c /etc/supervisord/supervisord.conf

