WITH cast_values AS (
  SELECT * EXCEPT (raw_value), CAST(raw_value AS DOUBLE) AS value
  FROM raw_values
  UNION ALL
  SELECT * EXCEPT (raw_value), CAST(raw_value AS DOUBLE) AS value
  FROM raw_values
)
INSERT OVERWRITE TABLE double_values
SELECT * FROM cast_values
WHERE value > 0;
