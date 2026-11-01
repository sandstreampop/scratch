"""Step 1: cut the painting out of the photo and straighten it.
Corner lines were measured from the gilt frame's inner lip (see work/ notes)."""
from PIL import Image
import numpy as np, sys

SRC, DST = 'work/photo.jpg', 'work/plate.jpg'
OUT_W, OUT_H = 1472, 1768

def line(p0, p1):            # returns (a,b,c) with a*x+b*y=c
    (x0,y0),(x1,y1)=p0,p1
    a, b = y1-y0, x0-x1
    return a, b, a*x0+b*y0
def cross(l1, l2):
    a1,b1,c1=l1; a2,b2,c2=l2; d=a1*b2-a2*b1
    return ((c1*b2-c2*b1)/d, (a1*c2-a2*c1)/d)

top    = line((60,150),(1460,128))
bottom = line((150,1914),(1350,1898))
left   = line((9,250),(24,1800))
right  = line((1470,250),(1492,1800))
tl,tr,br,bl = cross(top,left),cross(top,right),cross(bottom,right),cross(bottom,left)
print('corners', [tuple(round(v) for v in p) for p in (tl,tr,br,bl)])

def coeffs(src, dst):        # PIL wants dst->src mapping
    A=[]; B=[]
    for (x,y),(u,v) in zip(dst, src):
        A.append([x,y,1,0,0,0,-u*x,-u*y]); B.append(u)
        A.append([0,0,0,x,y,1,-v*x,-v*y]); B.append(v)
    return np.linalg.solve(np.array(A,float), np.array(B,float))
im = Image.open(SRC).convert('RGB')
c = coeffs([tl,tr,br,bl], [(0,0),(OUT_W,0),(OUT_W,OUT_H),(0,OUT_H)])
out = im.transform((OUT_W,OUT_H), Image.PERSPECTIVE, c, Image.BICUBIC)
out.save(DST, quality=95)
print('wrote', DST, out.size)
