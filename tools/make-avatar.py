#!/usr/bin/env python3
"""
从一张原始照片裁出网页用的正方形头像 -> avatar.jpg

当时用的原图是 1440x1920 的竖幅人像，脸大致在中间偏上，
裁切框 (275, 300, 1035, 1060) 是试了几次调出来的：脸居中，
圆形遮罩下不会切掉发顶。

用法：
    python3 tools/make-avatar.py 原图.jpg
    python3 tools/make-avatar.py 原图.jpg --box 275,300,1035,1060 --size 480

不传 --box 就用上面那组默认值（换新照片多半要重调，
可以先跑 --preview 输一张带圆形遮罩的预览图看看效果）。
"""

import argparse
import os
import sys

from PIL import Image, ImageDraw

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, '..', 'avatar.jpg')
DEFAULT_BOX = (275, 300, 1035, 1060)


def main():
    p = argparse.ArgumentParser()
    p.add_argument('src', help='原图路径')
    p.add_argument('--box', default=None, help='裁切框 x0,y0,x1,y1（默认适配当时那张照片）')
    p.add_argument('--size', type=int, default=480, help='输出边长，默认 480')
    p.add_argument('--quality', type=int, default=88, help='JPEG 质量，默认 88')
    p.add_argument('--preview', action='store_true', help='额外输出一张带圆形遮罩的预览图')
    args = p.parse_args()

    im = Image.open(args.src).convert('RGB')
    print('原图尺寸:', im.size)

    if args.box:
        box = tuple(int(x) for x in args.box.split(','))
    else:
        box = DEFAULT_BOX
        if im.size != (1440, 1920):
            print(f'注意: 原图不是 1440x1920，默认裁切框 {box} 可能不合适，建议用 --box 指定')
    print('裁切框:', box)

    sq = im.crop(box).resize((args.size, args.size), Image.LANCZOS)
    sq.save(OUT, quality=args.quality, optimize=True)
    print('已写出:', os.path.abspath(OUT), f'({args.size}x{args.size})')

    if args.preview:
        mask = Image.new('L', (args.size, args.size), 0)
        ImageDraw.Draw(mask).ellipse((0, 0, args.size - 1, args.size - 1), fill=255)
        canvas = Image.new('RGB', (args.size, args.size), (255, 255, 255))
        canvas.paste(sq, (0, 0), mask)
        prev = os.path.join(HERE, 'screenshots', 'avatar-preview-circle.jpg')
        os.makedirs(os.path.dirname(prev), exist_ok=True)
        canvas.save(prev, quality=92)
        print('圆形预览:', os.path.abspath(prev))


if __name__ == '__main__':
    sys.exit(main())
