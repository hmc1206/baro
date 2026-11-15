# Baro 앱 아이콘 생성: 둥근 사각형 그라디언트 + 흰 번개. 실행: python3 design/make_icon.py
from PIL import Image, ImageDraw, ImageFilter

S = 2048                      # 2배로 그린 뒤 축소해 가장자리를 부드럽게
OUT = 1024
inset, radius = 200, 370      # macOS 아이콘 격자: 1024 기준 여백 100, 모서리 185

def lerp(a, b, t): return tuple(int(a[i] + (b[i] - a[i]) * t) for i in range(3))

# 대각선 그라디언트 (왼쪽 위 보라 → 오른쪽 아래 파랑)
top, bot = (124, 92, 255), (37, 99, 235)
grad = Image.new("RGB", (S, S))
px = grad.load()
for y in range(S):
    for x in range(S):
        px[x, y] = lerp(top, bot, (x + y) / (2 * S))

mask = Image.new("L", (S, S), 0)
ImageDraw.Draw(mask).rounded_rectangle([inset, inset, S - inset, S - inset], radius, fill=255)

icon = Image.new("RGBA", (S, S), (0, 0, 0, 0))
# 아래쪽 그림자
shadow = Image.new("RGBA", (S, S), (0, 0, 0, 0))
ImageDraw.Draw(shadow).rounded_rectangle([inset, inset + 24, S - inset, S - inset + 24], radius, fill=(0, 0, 0, 90))
icon.alpha_composite(shadow.filter(ImageFilter.GaussianBlur(28)))
icon.paste(grad, (0, 0), mask)

# 위쪽 은은한 하이라이트
# 위에서 아래로 점점 사라지는 하이라이트
fade = Image.new("L", (1, S))
for y in range(S):
    fade.putpixel((0, y), max(0, int(46 * (1 - (y - inset) / (S * 0.55)))) if y >= inset else 0)
hl = Image.new("RGBA", (S, S), (255, 255, 255, 0))
hl.putalpha(Image.composite(fade.resize((S, S)), Image.new("L", (S, S), 0), mask))
icon.alpha_composite(hl)

# 번개 (중앙)
c = S / 2
bolt = [(c + 90, c - 560), (c - 330, c + 70), (c - 20, c + 70), (c - 110, c + 560), (c + 330, c - 80), (c + 20, c - 80)]
b = Image.new("RGBA", (S, S), (0, 0, 0, 0))
ImageDraw.Draw(b).polygon(bolt, fill=(0, 0, 0, 70))
icon.alpha_composite(b.filter(ImageFilter.GaussianBlur(18)).transform((S, S), Image.AFFINE, (1, 0, 0, 0, 1, -18)))
ImageDraw.Draw(icon).polygon(bolt, fill=(255, 255, 255, 255))

icon.resize((OUT, OUT), Image.LANCZOS).save("design/icon.png")
print("design/icon.png")
