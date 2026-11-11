from PIL import Image
from pathlib import Path
import numpy as np
import json
root=Path(r'D:/plugin/deepseek-harness/plugins/dsh-gpt-images')
items=[('generated-6e5af886e296ccca06bd838f167440cb.png','wind-turbine-1960x760.png'),('generated-9a059996bc74f82b1684e19098ff86a0.png','parts-1960x760.png'),('generated-3f4d9a621cca688b82c724e0f41c02e8.png','sensor-1960x760.png'),('generated-6f1fa82e09c30d98b1708843e8696d76.png','alarm-1960x760.png')]
results=[]
for src,dst in items:
 im=Image.open(root/src).convert('RGB')
 a=np.asarray(im).astype(float)
 h,w=a.shape[:2]
 signal=np.minimum(a[:,:,1],a[:,:,2])-a[:,:,0]
 mask=(signal>95)&(a[:,:,1]>125)&(a[:,:,2]>135)
 col=mask[int(h*.12):int(h*.83)].sum(axis=0)
 row=mask[:,int(w*.30):int(w*.85)].sum(axis=1)
 left=int(np.argmax(col[:int(w*.10)])); right=int(w*.90)+int(np.argmax(col[int(w*.90):]))
 top=int(np.argmax(row[:int(h*.15)])); bottom=int(h*.8)+int(np.argmax(row[int(h*.8):]))
 # Crop at the outer edge of each luminous frame, leaving no external padding.
 box=(max(0,left-2),max(0,top-2),min(w,right+3),min(h,bottom+3))
 out=im.crop(box).resize((1960,760),Image.Resampling.LANCZOS)
 out.save(root/dst)
 results.append({'file':dst,'crop':box,'size':out.size})
print(json.dumps(results))
