#!/bin/sh
# 사용: ts 1700000000 → 날짜, ts만 입력 → 현재 타임스탬프
if [ -z "$1" ]; then
  echo "현재 타임스탬프: $(date +%s)"
  echo "현재 시각: $(date '+%Y-%m-%d %H:%M:%S')"
else
  echo "$1 → $(date -r "$1" '+%Y-%m-%d %H:%M:%S' 2>/dev/null || echo '올바른 숫자가 아니에요')"
fi
