# Catalog files

Put per-template extras here (the installer copies them from vlab 1.x's `cmdb` folder on brownfield sites):

| File | Purpose |
|---|---|
| `descriptions.tbl` | one line per template: `lab_name=Text shown on the catalog card` (admins can also edit this in the portal) |
| `lab_name.jpg` or `.png` | topology picture shown on the catalog card and lab page |
| `lab_name.conf` | override the jumphost RDP login for copies of this template: `rdpdomain=`, `rdpuser=`, `rdppassword=` |
