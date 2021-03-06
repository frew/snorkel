"use strict";

var url = require("url");
var http = require("http");
var mongo = require("mongodb");
var context = require_root("server/context");
var config = require_root("server/config");

var DATASET_PREFIX = "datasets/";

var snorkle_db = require_root("server/db")
  .db("snorkel", function(db, db_name) {
    db.createCollection(db_name,
      {
        capped: true,
        size: config.default_max_dataset_size
      }, function(err, data) { });
  });

function round_column(col, out_col, bin_size) {
  var transform = {};

  bin_size = bin_size || 100;
  var original = { $divide : [ { $subtract : [ "$integer." + col, {$mod :
    ["$integer." + col, 1]}] }, bin_size ]};
  var remainder = {$mod : [original, 1]};

  var divisor = { $subtract: [ original, remainder ]};
  var value = { $multiply: [ divisor, bin_size ]};
  transform[out_col] = value;


  return transform;
}

function weight_column(col, weight_col, out_col) {
  if (col === "weight") {
    return {};
  }

  var weighted = { $multiply: [ "$integer." + col, "$integer." + weight_col ] };
  var transform = {};
  transform[out_col || "integer." + col] = weighted;

  return transform;
}

// multiply_cols_by_weight
function multiply_cols_by_weight(cols, weight_col, group_by) {

  var projection = {};
  _.each(cols, function(col) {
    _.extend(projection, weight_column(col, weight_col));
  });

  _.extend(projection, { "weighted_count" : "$integer." + weight_col });

  _.each(group_by, function(field) {
    projection["string." + field] = 1;
  });

  // Also grab the time column
  projection["integer.time"] = 1;

  if (Object.keys(projection).length) {
    return [{ $project: projection }];
  }

  return [];
}

function cast_columns(translate, cols, weight_col, group_by) {
  var projection = {};

  var translated = {};
  _.each(translate, function(tr) {
    var orig_name = "$" + tr.from_type + "." + tr.name;
    var to_name = tr.to_type + "." + tr.name;
    translated[to_name] = true;

    projection[to_name] = orig_name;

  });

  _.each(cols, function(col) {
    if (translated["integer." + col]) {
      return;
    }

    projection["integer." + col] = 1;
  });

  if (weight_col) {
    projection["integer." + weight_col] = 1;
  }

  _.each(group_by, function(field) {
    if (translated["string." + field]) {
      return;
    }

    projection["string." + field] = 1;
  });

  // Also grab the time column
  projection["integer.time"] = 1;

  if (Object.keys(projection).length) {
    return [{ $project: projection }];
  }

  return [];
}

function query_table(opts) {
  var dims = opts.dims, cols = opts.cols;
  var agg = opts.agg;
  var pipeline = [];

  if (opts.weight_col) {
    var weighting = multiply_cols_by_weight(opts.cols, opts.weight_col, opts.dims);
    pipeline = pipeline.concat(weighting);
  }

  var dim_groups = {};
  _.each(dims, function(dim) {
    dim_groups[dim] = "$string." + dim;
  });

  var group_by = {$group: { _id: dim_groups, count: { $sum: 1 } }};

  _.each(cols, function(col) {
    group_by.$group[col] = {};
    var col_val = "$integer." + col;
    var temp_agg = agg;
    if (agg === "$count") {   col_val = 1; temp_agg = "$sum"; }
    group_by.$group[col][temp_agg] = col_val;
  });

  if (opts.weight_col) {
    group_by.$group.weighted_count = { $sum: "$weighted_count"};
  }

  pipeline.push(group_by);


  return pipeline;
}

function query_time_series(opts) {
  var dims = opts.dims, cols = opts.cols;
  var agg = opts.agg;
  var pipeline = [];

  if (opts.weight_col) {
    var weighting = multiply_cols_by_weight(opts.cols, opts.weight_col, opts.dims);
    pipeline = pipeline.concat(weighting);
  }

  opts.time_bucket = opts.time_bucket || 60 * 60 * 6; // 6 hours?

  var dim_groups = {};
  _.each(dims, function(dim) {
    dim_groups[dim] = "$string." + dim;
  });

  dim_groups = _.extend(dim_groups, round_column("time", "time_bucket", opts.time_bucket));

  var group_by = {$group: { _id: dim_groups, count: { $sum: 1 } }};
  if (opts.weight_col) {
    group_by.$group.weighted_count = { $sum: "$weighted_count" };
  }

  _.each(cols, function(col) {
    group_by.$group[col] = {};
    var col_val = "$integer." + col;
    var temp_agg = agg;
    if (agg === "$count") {   col_val = 1; temp_agg = "$sum"; }
    group_by.$group[col][temp_agg] = col_val;
  });

  pipeline.push(group_by);


  return pipeline;
}

// TODO: supply buckets by hand that can be queried
// Has to go through transformations, later
function query_hist(opts, col_config) {
  var col = opts.col, bucket_size = opts.hist_bucket;

  if (!col && opts.cols) {
    col = opts.cols[0];
  }

  if (!col) {
    console.log("COULDNT FIND FIELD FOR DISTRIBUTION QUERY");
  }

  if (!bucket_size) {
    var col_meta = col_config[col];
    if (col_meta.max_value && col_meta.min_value) {
      var col_range = Math.abs(col_meta.max_value - col_meta.min_value);
      bucket_size = parseInt(col_range / 100, 10) + 1;
      console.log("INFERRING BUCKET SIZE", bucket_size);
    } else {
      bucket_size = 100;
    }
  }

  var pipeline = [];

  var projection = { $project: round_column(col, "bucket", bucket_size) };
  if (opts.weight_col) {
    projection.$project["integer." + opts.weight_col] = 1;
  }

  pipeline.push(projection);

  var col_name = {};
  col_name[col] = "$bucket";


  var group_op = { $group: {
      _id: col_name,
      count: { $sum: 1 },
      weighted_count: { $sum: "$integer." + opts.weight_col }
    }};

  pipeline.push(group_op);

  return pipeline;
}

function query_samples(opts) {

  opts = opts || {};
  var pipeline = [];

  pipeline.push({$sort: { "integer.time" : -1}});
  pipeline.push({$limit: opts.limit || 100 });
  return pipeline;
}

function get_stats(table, cb) {
  cb = context.wrap(cb);
  var collection = snorkle_db.get(DATASET_PREFIX + table);
  collection.stats(function(err, stats) {
    cb(stats);
  });
}

var _cached_columns = {};
function clear_cache(table, cb) {
  if (_cached_columns[table]) {
    delete _cached_columns[table];
  }

  if (cb) {
    cb();
  }
}

function get_columns(table, cb) {

  if (_cached_columns[table]) {
    console.log("Using cached column results");
    var cached_for = (Date.now() - _cached_columns[table].updated) / 1000;
    cb(_cached_columns[table].results);
    cb = function() { };
    if (cached_for < 60 * 10) {
      return;
    }
  }

  console.log("Updating cached column results for table", table);

  // First, check if we have a relatively up to date metadata definition.
  var pipeline = query_samples({ limit: 500 });
  var schema = {};
  var collection = snorkle_db.get(DATASET_PREFIX + table);
  cb = context.wrap(cb);

  var values = {};
  collection.aggregate(pipeline, function(err, data) {
    _.each(data, function(sample) {
      _.each(sample, function(fields, field_type) {
        _.each(fields, function(value, field) {
          if (!schema[field]) {
            schema[field] = {};
            values[field] = {};
          }
          if (!schema[field][field_type]) {
            schema[field][field_type] = 0;
            values[field][field_type] = [];
          }
          schema[field][field_type] += 1;
          values[field][field_type].push(value);
        });
      });
    });

    var cols = [];
    _.each(schema, function(field_types, field) {
      if (field === "_bsontype") { // Skip that bad boy
        return;
      }

      var max = 0;
      var predicted_type = null;

      _.each(field_types, function(count, type) {
        if (count > max) {
          predicted_type = type;
          max = count;

        }
      });

      var col_meta = {
        name: field,
        type_str: predicted_type};

      // can we auto-windsorize these values?
      if (predicted_type === "integer") {
        var int_values = values[field].integer;
        int_values.sort(function(a, b) { return a - b; });

        var high_p = parseInt(0.975 * int_values.length, 10);
        var low_p = parseInt(0.025 * int_values.length, 10);

        if (int_values.length > 100) {
          col_meta.max_value = int_values[high_p];
          col_meta.min_value = int_values[low_p];
        }
      }

      cols.push(col_meta);

    });

    _cached_columns[table] = {
      results: cols,
      updated: Date.now()
    };

    cb(cols);
  });

}

function get_tables(cb) {
  cb = context.wrap(cb);

  snorkle_db.raw().collectionNames(function(err, collections) {
    var datasets = [];

    _.each(collections, function(collection) {
      var idx = collection.name.indexOf(DATASET_PREFIX);
      if (idx > -1) {
        datasets.push({
            table_name: collection.name.substr(idx + DATASET_PREFIX.length)
          });
      }
    });

    cb(datasets);

  });
}

// filters is an array of filters
// a filter looks like:
// {
//   column: <name>
//   conditions: [
//     { "$gt" : 1000 },
//     { "$lt" : 1200 }
//  ]
// }
function add_filters(filters) {
  var pipeline = [];

  _.each(filters, function(filter) {
    var transform = { $match: {}};
    var col = filter.column;

    if (!col) {
      // TODO: error here
      console.log("Missing column for filter: ", filter);
    }

    transform.$match[col] = {};
    _.each(filter.conditions, function(cond) {
      transform.$match[col][cond.op] = cond.value;
    });

    pipeline.push(transform);
  });


  return pipeline;
}

function add_time_range(start, end) {
  var conditions = [];
  if (start) {
    conditions.push({value: start, op: "$gt"});
  }

  if (end) {
    conditions.push({value: end, op: "$lt"});
  }

  var pipeline = add_filters([{
    column: "integer.time",
    conditions: conditions
  }]);

  return pipeline;
}

// matches full integer samples, avoiding the 'null' cell problem
function trim_and_match_full_samples(cols, col_config) {
  var conditions = [];

  if (!cols.length) {
    return [];
  }

  _.each(cols, function(col) {
    var column = "integer." + col;
    var conds = [];

    conditions.push({
      $or: conds
    });


    _.each(["$gte", "$lt"], function(op) {
      var cond = {};
      cond[column] = {};
      cond[column][op] = 0;

      var col_meta = col_config[col];

      if (col_meta) {
        if (op === "$lt" && col_meta.max_value) {
            cond[column][op] = col_meta.max_value;
        }


        if (op === "$gte" && col_meta.min_value) {
            cond[column][op] = col_meta.min_value;
        }
      }

      cond[column].$ne = NaN;

      conds.push(cond);
    });

  });

  return [ { $match: { $and: conditions} } ];
}

function drop_dataset(collection_name, cb) {
  var collection = snorkle_db.get(DATASET_PREFIX + collection_name);
  cb = context.wrap(cb);
  collection.drop();
  cb(collection_name);
}

function run_pipeline(collection_name, pipeline, unweight, cb) {
  var collection = snorkle_db.get(DATASET_PREFIX + collection_name);
  cb = context.wrap(cb);

  // Before doing anything, we need to massage the data to its expected form (cast columns)


  collection.aggregate(pipeline, function(err, data) {
    if (unweight) {
      _.each(data, function(result) {
        var count = result.count;
        var weighted_count = result.weighted_count || count;

        _.each(result, function(val, key) {
          if (key === "weighted_count" || key === "count" || key === "_id") {
            return;
          }

          result[key] = val * count / weighted_count;
        });
      });
    }

    cb(err, data);
  });
}

function add_samples(dataset, subset, samples, cb) {
  var collection, collection_name;
  collection_name = DATASET_PREFIX + dataset;
  if (subset) {
    collection_name += "/" + subset;
  }

  _.each(samples, function(sample) {
    // TODO: more validation!
    if (!_.isObject(sample.integer)) {
      return;
    }
    _.each(sample.integer, function(value, key) {
      sample.integer[key] = parseInt(value, 10);
    });
  });

  var chunk_size = 1000;
  var chunks = Math.ceil(samples.length / chunk_size);

  var after = _.after(chunks, cb);

  snorkle_db.get(collection_name, function(collection) {
    var i;
    for (i = 0; i < chunks; i++) {
      var subsamples = samples.slice(i * chunk_size, (i + 1) * chunk_size);

      if (!subsamples.length) {
        after(null, []);
      }

      collection.insert(subsamples, function(err, data) {
        if (err) { console.log("ERROR INSERTING DATA", data); return; }
        after(err, data);
      });
    }
  });
}

function add_sample(dataset, subset, sample, cb) {
    add_samples(dataset, subset, [sample], cb);
}

module.exports = {

  // Query builders
  samples: query_samples,
  time_series: query_time_series,
  hist: query_hist,
  table: query_table,

  // Filters
  add_filters: add_filters,
  time_range: add_time_range,
  full_samples: trim_and_match_full_samples,
  cast_columns: cast_columns,

  // Metadata
  get_columns: get_columns,
  get_stats: get_stats,
  get_tables: get_tables,
  clear_cache: clear_cache,


  // Execution
  run: run_pipeline,
  drop: drop_dataset,

  // Insertion
  add_sample: add_sample,
  add_samples: add_samples
};

