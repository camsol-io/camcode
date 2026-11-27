# Test fixtures

Six tests in `extended.test.mjs` read images from the public benchmark dataset (the Barcode Reading Benchmark demo
dataset published by Dynamsoft, https://www.dynamsoft.com/barcode-dataset/benchmark/dataset), used only where no
synthetic image reproduces the case. The dataset's license terms are not stated, so the images are not in this
repository (`.gitignore`). Without them those six tests are skipped. To run them, put the files below into this folder;
the SHA-256 values tell you whether you have the right ones.

| File | Source | SHA-256 | Used by |
|---|---|---|---|
| `qr-pathological-image007.png` | `QRCode/pathological/image007.png`, unchanged (dev split) | see below | `rotated-30` test |
| `qr-damaged-image008-third.png` | `QRCode/damaged/image008.jpg` as the app reads it (canvas pixels), gray, shrunk to 1/3 (dev split) | see below | `global-denoise` test |
| `qr-blurred-image015-crop.png` | `QRCode/blurred/image015.jpg` as the app reads it, gray, a 2.5x window around the code (dev split) | see below | `upscale-2` test |
| `dm-dmx3a-crop.png` | `DataMatrix/DMX3a.jpg` as the app reads it, gray, a 2.5x window around its third code (dev split) | see below | `highlights` test |
| `qr-blurred-image027.png` | `QRCode/blurred/image027.jpg` as the app reads it, gray, whole image (dev split) | see below | `tiles-3` test |
| `qr-pathological-image006.png` | `QRCode/pathological/image006.png`, unchanged (hold-out split: no dev image needs the pass, and no synthetic finder damage tried reproduced it) | see below | `pure` test |

SHA-256:

`qr-pathological-image007.png`: 75bfe0960b8e1b4e45536b7fcbf9668da78855408a168e73365eb87398affc1a
`qr-damaged-image008-third.png`: bab9aea3e5cba908d50713b0f999d26cd96d3a940458cb30f4e69fc2ac842162
`qr-blurred-image015-crop.png`: f518f37038b6d7e65928b8af167fbe78c96a2e797f404b77aec08eb31883dc37
`dm-dmx3a-crop.png`: 2572f3ea7f3e96572928c38e6a603c3b85ebdc390282385362c0936328cdf9c7
`qr-blurred-image027.png`: 1807c6031019787ffe27c8399e29c0b893bf68f860af2c41e73be77e88154b0c
`qr-pathological-image006.png`: fd7b3f7c0165af9d775e7bd4fca9de9566b1f539d6f473cc4c0a7476a8ffa5f3
