WITH cast_values AS (
  SELECT CAST(raw_value AS DOUBLE) AS value
  FROM raw_values
  UNION ALL
  SELECT CAST(raw_value AS DOUBLE) AS value
  FROM raw_values
)
INSERT OVERWRITE TABLE double_values
SELECT value FROM cast_values;
