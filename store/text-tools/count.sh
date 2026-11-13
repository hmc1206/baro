#!/bin/sh
# 사용: count 텍스트
c=$(printf '%s' "$1" | wc -m | tr -d ' ')
n=$(printf '%s' "$1" | tr -d ' \n' | wc -m | tr -d ' ')
echo "글자 수: $c (공백 제외 $n)"
