from PIL import Image
from pathlib import Path
import json
root = Path(__file__).resolve().parent
source = Image.open(root / 'generated-f955d1a3f9bfc2ccefa50a0f3ba312b9.png')
w, h = source.size
size = 512
boxes = {
    'corner-top-left.png': (0, 0, size, size),
    'corner-top-right.png': (w-size, 0, w, size),
    'corner-bottom-left.png': (0, h-size, size, h),
    'corner-bottom-right.png': (w-size, h-size, w, h),
}
for name, box in boxes.items():
    path = root / name
    source.crop(box).save(path)
    with Image.open(path) as result:
        assert result.size == (512, 512)
    print(json.dumps({'file': name, 'size': [512, 512]}, ensure_ascii=False))
