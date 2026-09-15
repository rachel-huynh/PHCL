-- =====================================================================
-- asset-intake — Danh mục xuất xứ: ISO 3166-1 alpha-2 (đầy đủ)
-- Danh sách phải ĐẦY ĐỦ thì quy tắc "chỉ gán mã khi khớp đúng MỘT quốc gia
-- có thật" mới đúng — thiếu nước nào là nước đó bị xếp nhầm 'not_a_country'.
-- Chạy SAU 01_schema.sql.
-- =====================================================================

insert into am_origin (iso2, name_en) values
('AD','Andorra'),('AE','United Arab Emirates'),('AF','Afghanistan'),('AG','Antigua and Barbuda'),
('AI','Anguilla'),('AL','Albania'),('AM','Armenia'),('AO','Angola'),('AQ','Antarctica'),
('AR','Argentina'),('AS','American Samoa'),('AT','Austria'),('AU','Australia'),('AW','Aruba'),
('AX','Aland Islands'),('AZ','Azerbaijan'),('BA','Bosnia and Herzegovina'),('BB','Barbados'),
('BD','Bangladesh'),('BE','Belgium'),('BF','Burkina Faso'),('BG','Bulgaria'),('BH','Bahrain'),
('BI','Burundi'),('BJ','Benin'),('BL','Saint Barthelemy'),('BM','Bermuda'),('BN','Brunei Darussalam'),
('BO','Bolivia'),('BQ','Bonaire, Sint Eustatius and Saba'),('BR','Brazil'),('BS','Bahamas'),
('BT','Bhutan'),('BV','Bouvet Island'),('BW','Botswana'),('BY','Belarus'),('BZ','Belize'),
('CA','Canada'),('CC','Cocos (Keeling) Islands'),('CD','Congo, Democratic Republic of the'),
('CF','Central African Republic'),('CG','Congo'),('CH','Switzerland'),('CI','Cote d Ivoire'),
('CK','Cook Islands'),('CL','Chile'),('CM','Cameroon'),('CN','China'),('CO','Colombia'),
('CR','Costa Rica'),('CU','Cuba'),('CV','Cabo Verde'),('CW','Curacao'),('CX','Christmas Island'),
('CY','Cyprus'),('CZ','Czechia'),('DE','Germany'),('DJ','Djibouti'),('DK','Denmark'),
('DM','Dominica'),('DO','Dominican Republic'),('DZ','Algeria'),('EC','Ecuador'),('EE','Estonia'),
('EG','Egypt'),('EH','Western Sahara'),('ER','Eritrea'),('ES','Spain'),('ET','Ethiopia'),
('FI','Finland'),('FJ','Fiji'),('FK','Falkland Islands'),('FM','Micronesia'),('FO','Faroe Islands'),
('FR','France'),('GA','Gabon'),('GB','United Kingdom'),('GD','Grenada'),('GE','Georgia'),
('GF','French Guiana'),('GG','Guernsey'),('GH','Ghana'),('GI','Gibraltar'),('GL','Greenland'),
('GM','Gambia'),('GN','Guinea'),('GP','Guadeloupe'),('GQ','Equatorial Guinea'),('GR','Greece'),
('GS','South Georgia and the South Sandwich Islands'),('GT','Guatemala'),('GU','Guam'),
('GW','Guinea-Bissau'),('GY','Guyana'),('HK','Hong Kong'),('HM','Heard Island and McDonald Islands'),
('HN','Honduras'),('HR','Croatia'),('HT','Haiti'),('HU','Hungary'),('ID','Indonesia'),
('IE','Ireland'),('IL','Israel'),('IM','Isle of Man'),('IN','India'),
('IO','British Indian Ocean Territory'),('IQ','Iraq'),('IR','Iran'),('IS','Iceland'),
('IT','Italy'),('JE','Jersey'),('JM','Jamaica'),('JO','Jordan'),('JP','Japan'),('KE','Kenya'),
('KG','Kyrgyzstan'),('KH','Cambodia'),('KI','Kiribati'),('KM','Comoros'),
('KN','Saint Kitts and Nevis'),('KP','Korea, Democratic People s Republic of'),
('KR','Korea, Republic of'),('KW','Kuwait'),('KY','Cayman Islands'),('KZ','Kazakhstan'),
('LA','Lao People s Democratic Republic'),('LB','Lebanon'),('LC','Saint Lucia'),
('LI','Liechtenstein'),('LK','Sri Lanka'),('LR','Liberia'),('LS','Lesotho'),('LT','Lithuania'),
('LU','Luxembourg'),('LV','Latvia'),('LY','Libya'),('MA','Morocco'),('MC','Monaco'),
('MD','Moldova'),('ME','Montenegro'),('MF','Saint Martin (French part)'),('MG','Madagascar'),
('MH','Marshall Islands'),('MK','North Macedonia'),('ML','Mali'),('MM','Myanmar'),
('MN','Mongolia'),('MO','Macao'),('MP','Northern Mariana Islands'),('MQ','Martinique'),
('MR','Mauritania'),('MS','Montserrat'),('MT','Malta'),('MU','Mauritius'),('MV','Maldives'),
('MW','Malawi'),('MX','Mexico'),('MY','Malaysia'),('MZ','Mozambique'),('NA','Namibia'),
('NC','New Caledonia'),('NE','Niger'),('NF','Norfolk Island'),('NG','Nigeria'),('NI','Nicaragua'),
('NL','Netherlands'),('NO','Norway'),('NP','Nepal'),('NR','Nauru'),('NU','Niue'),
('NZ','New Zealand'),('OM','Oman'),('PA','Panama'),('PE','Peru'),('PF','French Polynesia'),
('PG','Papua New Guinea'),('PH','Philippines'),('PK','Pakistan'),('PL','Poland'),
('PM','Saint Pierre and Miquelon'),('PN','Pitcairn'),('PR','Puerto Rico'),('PS','Palestine'),
('PT','Portugal'),('PW','Palau'),('PY','Paraguay'),('QA','Qatar'),('RE','Reunion'),
('RO','Romania'),('RS','Serbia'),('RU','Russian Federation'),('RW','Rwanda'),
('SA','Saudi Arabia'),('SB','Solomon Islands'),('SC','Seychelles'),('SD','Sudan'),
('SE','Sweden'),('SG','Singapore'),('SH','Saint Helena, Ascension and Tristan da Cunha'),
('SI','Slovenia'),('SJ','Svalbard and Jan Mayen'),('SK','Slovakia'),('SL','Sierra Leone'),
('SM','San Marino'),('SN','Senegal'),('SO','Somalia'),('SR','Suriname'),('SS','South Sudan'),
('ST','Sao Tome and Principe'),('SV','El Salvador'),('SX','Sint Maarten (Dutch part)'),
('SY','Syrian Arab Republic'),('SZ','Eswatini'),('TC','Turks and Caicos Islands'),('TD','Chad'),
('TF','French Southern Territories'),('TG','Togo'),('TH','Thailand'),('TJ','Tajikistan'),
('TK','Tokelau'),('TL','Timor-Leste'),('TM','Turkmenistan'),('TN','Tunisia'),('TO','Tonga'),
('TR','Turkiye'),('TT','Trinidad and Tobago'),('TV','Tuvalu'),('TW','Taiwan'),
('TZ','Tanzania'),('UA','Ukraine'),('UG','Uganda'),
('UM','United States Minor Outlying Islands'),('US','United States of America'),
('UY','Uruguay'),('UZ','Uzbekistan'),('VA','Holy See'),('VC','Saint Vincent and the Grenadines'),
('VE','Venezuela'),('VG','Virgin Islands (British)'),('VI','Virgin Islands (U.S.)'),
('VN','Viet Nam'),('VU','Vanuatu'),('WF','Wallis and Futuna'),('WS','Samoa'),('YE','Yemen'),
('YT','Mayotte'),('ZA','South Africa'),('ZM','Zambia'),('ZW','Zimbabwe')
on conflict (iso2) do update set name_en = excluded.name_en;

-- Tên tiếng Việt cho các nước hay gặp trong hồ sơ mua sắm
update am_origin set name_vi = v.vi from (values
  ('VN','Việt Nam'),('CN','Trung Quốc'),('JP','Nhật Bản'),('KR','Hàn Quốc'),
  ('TW','Đài Loan'),('TH','Thái Lan'),('MY','Malaysia'),('SG','Singapore'),
  ('ID','Indonesia'),('PH','Philippines'),('IN','Ấn Độ'),('US','Mỹ'),
  ('GB','Anh'),('DE','Đức'),('FR','Pháp'),('IT','Ý'),('ES','Tây Ban Nha'),
  ('NL','Hà Lan'),('BE','Bỉ'),('CH','Thụy Sĩ'),('SE','Thụy Điển'),('AT','Áo'),
  ('PL','Ba Lan'),('TR','Thổ Nhĩ Kỳ'),('RU','Nga'),('AU','Úc'),('NZ','New Zealand'),
  ('CA','Canada'),('MX','Mexico'),('BR','Brazil'),('HK','Hồng Kông'),('MO','Ma Cao'),
  ('KH','Campuchia'),('LA','Lào'),('MM','Myanmar'),('AE','UAE'),('DK','Đan Mạch'),
  ('NO','Na Uy'),('FI','Phần Lan'),('PT','Bồ Đào Nha'),('CZ','Séc'),('IL','Israel')
) as v(code, vi) where am_origin.iso2 = v.code;

-- ---------------------------------------------------------------------
-- Bí danh 1-1. CHỈ thêm khi chuỗi chỉ đích danh MỘT quốc gia.
-- alias_norm phải là kết quả của am_norm() (lower, bỏ dấu, gộp khoảng trắng).
-- ---------------------------------------------------------------------
insert into am_origin_alias (alias_norm, iso2, note) values
  ('usa','US',null),('u.s.a','US',null),('u.s.a.','US',null),('us','US',null),
  ('united states','US',null),('america','US',null),('my','US','"Mỹ" đã bỏ dấu'),
  ('viet nam','VN',null),('vietnam','VN',null),('vn','VN',null),
  ('china','CN',null),('p.r.c','CN',null),('prc','CN',null),('trung quoc','CN',null),
  ('chinese','CN',null),('made in china','CN',null),
  ('uk','GB',null),('england','GB',null),('great britain','GB',null),
  ('united kingdom','GB',null),('anh','GB',null),
  ('korea','KR',null),('south korea','KR',null),('han quoc','KR',null),('kr','KR',null),
  ('japan','JP',null),('nhat ban','JP',null),('jp','JP',null),
  ('taiwan','TW',null),('dai loan','TW',null),('tw','TW',null),
  ('thailand','TH',null),('thai lan','TH',null),
  ('malaysia','MY',null),('singapore','SG',null),('indonesia','ID',null),
  ('germany','DE',null),('duc','DE',null),('deutschland','DE',null),
  ('france','FR',null),('phap','FR',null),
  ('italy','IT',null),('italia','IT',null),('y','IT',null),
  ('spain','ES',null),('netherlands','NL',null),('holland','NL',null),
  ('switzerland','CH',null),('turkey','TR',null),('turkiye','TR',null),
  ('russia','RU',null),('australia','AU',null),('canada','CA',null),
  ('india','IN',null),('an do','IN',null),
  ('hong kong','HK',null),('hongkong','HK',null),
  ('uae','AE',null),('united arab emirates','AE',null),
  ('czech','CZ',null),('czech republic','CZ',null),
  ('brasil','BR',null)
on conflict (alias_norm) do update set iso2 = excluded.iso2, note = excluded.note;

-- ---------------------------------------------------------------------
-- Các chuỗi CỐ Ý không map — để UI giải thích vì sao bỏ trống xuất xứ.
-- ---------------------------------------------------------------------
insert into am_origin_rejected (raw_norm, raw_sample, reason) values
  ('asia',   'Asia',   'not_a_country'),
  ('eu',     'EU',     'not_a_country'),
  ('europe', 'Europe', 'not_a_country'),
  ('asean',  'ASEAN',  'not_a_country'),
  ('imported','Imported','not_a_country'),
  ('nhap khau','Nhập khẩu','not_a_country'),
  ('oem',    'OEM',    'not_a_country'),
  ('n/a',    'N/A',    'not_a_country')
on conflict (raw_norm) do nothing;
