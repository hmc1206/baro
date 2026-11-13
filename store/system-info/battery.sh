#!/bin/sh
pmset -g batt | tail -n +2 | sed 's/^[[:space:]]*-InternalBattery-0 ([^)]*)[[:space:]]*//'
