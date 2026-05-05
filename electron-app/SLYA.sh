#!/bin/sh
cd $( dirname $(realpath $0))
setsid ./electron . </dev/null >/dev/null 2>&1 &
sleep 1
