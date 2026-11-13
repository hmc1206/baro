#!/bin/sh
# 사용: b64 텍스트
printf '%s' "$1" | base64
