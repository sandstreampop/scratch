import numpy as np
from PIL import Image
M=np.array([(462,236),(527,180),(640,430),(522,155),(22,308),(135,240),(230,445),(715,670),(818,772),(100,535)],float)
C=np.array([(438,232),(497,180),(598,425),(492,150),(5,305),(100,235),(210,440),(668,665),(772,755),(85,530)],float)
X=np.hstack([M,np.ones((len(M),1))])
A,res,_,_=np.linalg.lstsq(X,C,rcond=None)
print(A.T); print("resid px", np.sqrt(((X@A-C)**2).sum(1)).round(1))
c=Image.open("assets/clean_raw.png"); m=Image.open("assets/messy_raw.png")
a=A.T.flatten()
w=c.transform(c.size,Image.AFFINE,tuple(a),resample=Image.BICUBIC,fillcolor=None)
# fill edge gaps: compose over edge-stretched version
arr=np.array(w).astype(float); cm=np.array(c).astype(float); mm=np.array(m).astype(float)
mask=(arr.sum(2)==0)
arr[mask]=mm[mask]
# match color stats on wall area (top 40%)
top=slice(0,480)
for k in range(3):
    s=arr[top,:,k]; t=mm[top,:,k]
    arr[:,:,k]=(arr[:,:,k]-s.mean())*(t.std()/s.std())*0.5+ (arr[:,:,k]-s.mean())*0.5 + t.mean()
Image.fromarray(arr.clip(0,255).astype(np.uint8)).save("assets/clean.jpg",quality=86)
m.save("assets/messy.jpg",quality=86)
print(mask.sum())
