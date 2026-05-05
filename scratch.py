from app import _try_supadata_key, _get_pool_keys
import os
try:
    keys = _get_pool_keys()
    if keys:
        res = _try_supadata_key(keys[0], 'iCx3zwK8Ms8')
        print(str(res)[:500])
except Exception as e:
    print(e)
