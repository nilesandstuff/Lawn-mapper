import json,sys
import numpy as np
for name in ['mi','tx','az','de','ga']:
    p=json.load(open(name+'.json'))['properties']['parameter']
    days=sorted(p['T2M'])
    G=np.array([p['ALLSKY_SFC_SW_DWN'][d] for d in days]); T=np.array([p['T2M'][d] for d in days]); S=np.array([p['TSOIL1'][d] for d in days])
    ok=(G>-90)&(T>-90)&(S>-90)
    def m5(a): return np.convolve(a,np.ones(5)/5,'valid')
    for lab,(g,t,s) in {'daily':(G,T,S),'5-day':(m5(G),m5(T),m5(S))}.items():
        okk=(g>-90)&(t>-90)&(s>-90)&(t>3)   # unfrozen
        X=np.c_[np.ones(okk.sum()),g[okk]]; y=(s-t)[okk]
        c,res,*_=np.linalg.lstsq(X,y,rcond=None); r=np.corrcoef(g[okk],y)[0,1]
        # also with air temp as covariate
        X2=np.c_[np.ones(okk.sum()),g[okk],t[okk]]; c2=np.linalg.lstsq(X2,y,rcond=None)[0]
        print(f"{name} {lab}: soil-air = {c[0]:.2f} + {c[1]:.3f}*GHI  r={r:.2f}  | with air: {c2[1]:.3f}*GHI {c2[2]:+.3f}*T")
