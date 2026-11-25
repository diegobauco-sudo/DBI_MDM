"""Genera el icono, el banner de Android TV y el fondo de pantalla por defecto."""
import math, sys
from PIL import Image, ImageDraw, ImageFilter, ImageFont
out = sys.argv[1]
TEAL=(57,208,196); NAVY=(11,19,32)
def font(size):
    for p in ["/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"]:
        try: return ImageFont.truetype(p,size)
        except OSError: pass
    return ImageFont.load_default()
def mark(d,cx,cy,s,c=TEAL):
    for r in (0.33,0.62,0.92):
        R=s*r; w=max(2,int(s*0.1))
        d.arc([cx-R,cy-R,cx+R,cy+R],start=225,end=315,fill=c,width=w)
    r=s*0.09; d.ellipse([cx-r,cy-r,cx+r,cy+r],fill=c)
S=4
im=Image.new("RGBA",(192*S,192*S),NAVY+(255,)); d=ImageDraw.Draw(im); mark(d,96*S,132*S,110*S)
im.resize((192,192),Image.LANCZOS).convert("RGB").save(f"{out}/drawable-nodpi/icon.png")
im=Image.new("RGBA",(192*S,192*S),(0,0,0,0)); d=ImageDraw.Draw(im); mark(d,96*S,132*S,110*S,(255,255,255))
im.resize((192,192),Image.LANCZOS).save(f"{out}/drawable-nodpi/wifi.png")
im=Image.new("RGB",(320*S,180*S),NAVY); d=ImageDraw.Draw(im); mark(d,56*S,112*S,62*S)
d.text((98*S,62*S),"WiFly",font=font(46*S),fill=(255,255,255))
im.resize((320,180),Image.LANCZOS).save(f"{out}/drawable-nodpi/banner.png")
W,H=1920,1080
im=Image.new("RGB",(W,H)); px=im.load()
for y in range(H):
    for x in range(W):
        t=(x/W*0.45+y/H*0.55)
        px[x,y]=(int(9+t*6),int(19+t*22),int(36+t*30))
g=Image.new("RGBA",(W,H),(0,0,0,0)); d=ImageDraw.Draw(g)
for i,r in enumerate(range(260,1500,190)):
    d.arc([1500-r,250-r,1500+r,250+r],start=95,end=215,fill=TEAL+(46-i*5,),width=26)
g=g.filter(ImageFilter.GaussianBlur(2))
im=Image.alpha_composite(im.convert("RGBA"),g).convert("RGB")
im.save(f"{out}/drawable-nodpi/wallpaper.jpg",quality=86)
