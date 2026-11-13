#!/bin/sh
# 내부 IP만 표시 (외부 서버에 요청하지 않음)
for i in en0 en1; do
  a=$(ipconfig getifaddr "$i" 2>/dev/null) && echo "$i: $a"
done
