from pathlib import Path
from PIL import Image
import numpy as np
import json
root = Path(__file__).resolve().parent
im = Image.open(root / 'generated-9d41083c7464950064edcf0ba5800089.png').convert('RGBA')
assert im.getchannel('A').getextrema()[0] == 0
alpha = np.array(im.getchannel('A'))
y, x = np.where(alpha > 12)
box = (max(0,int(x.min())-4), max(0,int(y.min())-4), min(im.width,int(x.max())+5), min(im.height,int(y.max())+5))
im = im.crop(box)
variants = {'top-left': im, 'top-right': im.transpose(Image.Transpose.FLIP_LEFT_RIGHT), 'bottom-left': im.transpose(Image.Transpose.FLIP_TOP_BOTTOM), 'bottom-right': im.transpose(Image.Transpose.ROTATE_180)}
for direction, asset in variants.items():
    out = root / ('corner-' + direction + '-transparent.png')
    asset.save(out)
    check = Image.open(out)
    assert check.mode == 'RGBA' and check.getchannel('A').getextrema()[0] == 0
    print(json.dumps({'file': out.name, 'size': asset.size, 'alpha': check.getchannel('A').getextrema()}))
