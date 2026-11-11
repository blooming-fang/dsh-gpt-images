from pathlib import Path
from PIL import Image
import numpy as np
import json
root = Path(__file__).resolve().parent
for name in ['top-left', 'top-right', 'bottom-left', 'bottom-right']:
    im = Image.open(root / ('corner-' + name + '.png')).convert('RGB')
    a = np.array(im)
    mask = (a[:,:,0] > 45) & (a[:,:,1] > 225) & (a[:,:,2] > 220)
    ys, xs = np.where(mask)
    assert len(xs) > 0
    pad = 8
    boxes = {'top-left': (58,56,249,240), 'top-right': (264,56,456,240), 'bottom-left': (58,271,249,456), 'bottom-right': (264,271,456,456)}
    box = boxes[name]
    out = root / ('corner-' + name + '-trimmed.png')
    cropped = im.crop(box)
    cropped.save(out)
    print(json.dumps({'file':out.name, 'crop':box, 'size':cropped.size}))
