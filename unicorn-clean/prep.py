from PIL import Image, ImageDraw
U="/root/.claude/uploads/4bbe5466-3e1e-54a6-89ab-6d6ecaacc850/"
W,H=900,1200
m=Image.open(U+"02c4883d-image.jpg").convert("RGB").resize((W,H),Image.LANCZOS)
c=Image.open(U+"6703ac37-image.jpg").convert("RGB").resize((W,H),Image.LANCZOS)
m.save("assets/messy_raw.png"); c.save("assets/clean_raw.png")
for im,n in((m,"m"),(c,"c")):
    g=im.copy(); d=ImageDraw.Draw(g)
    for x in range(0,W,50): d.line([(x,0),(x,H)],fill=(0,255,255) if x%100==0 else (0,120,120))
    for y in range(0,H,50): d.line([(0,y),(W,y)],fill=(0,255,255) if y%100==0 else (0,120,120))
    for x in range(0,W,100):
        for y in range(0,H,100): d.text((x+2,y+2),f"{x},{y}",fill=(255,255,0))
    g.save(f"/tmp/claude-0/-home-user-scratch/4bbe5466-3e1e-54a6-89ab-6d6ecaacc850/scratchpad/grid_{n}.png")
