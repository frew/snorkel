"use strict";

var helpers = require("client/views/helpers");
var BaseView = require("client/views/base_view");
var presenter = require("client/views/presenter");

var SamplesView = BaseView.extend({

  prepare: function(data) {
    // Samples are broken up into raw samples of
    // integer, string, set types
    var cols = {
      "integer" : {},
      "string" : {},
      "set" : {}
    }; 

    var lookup = {};

    // assume that first sample is full row? or just do two passes?
    _.each(data.results, function(result) {
      _.each(result.integer, function(val, field) {
        cols.integer[field] = true;
        lookup[field] = "integer";
      });
      _.each(result.set, function(val, field) {
        cols.set[field] = true;
        lookup[field] = "set";
      });
      _.each(result.string, function(val, field) {
        cols.string[field] = true;
        lookup[field] = "string";
      });
    });

    var headers = [];
    var integer_cols = Object.keys(cols.integer);
    var string_cols = Object.keys(cols.string);
    var set_cols = Object.keys(cols.set);
    var dataset = this.table;

    integer_cols.sort();
    set_cols.sort();
    string_cols.sort();


    var all_cols = string_cols.concat(integer_cols).concat(set_cols);
    _.each(all_cols, function(col) {
      headers.push(presenter.get_field_name(dataset, col));
    });

    var rows = [];
    _.each(data.results, function(result) {
      var row = [];
      _.each(all_cols, function(field) {
        var types = result[lookup[field]];
        if (!types) {
          row.push("");
          return;
        }
        row.push(result[lookup[field]][field]);
      });

      rows.push(row);
    });

    return {
      rows: rows,
      headers: headers
    };
  },

  finalize: function() {
    if (!this.data.rows.length) {
      return "No Samples";
    }
  },

  render: function() {
    var table = helpers.build_table(this.table, this.data.headers, this.data.rows);

    this.$el
      .append(table)
      .fadeIn();
  }
}, {
  icon: "noun/pin.svg"
});

jank.trigger("view:add", "samples",  {
  include: helpers.STD_INPUTS,
  exclude: [ "group_by", "compare", "agg", "field", "fieldset", "compare", "time_bucket", "hist_bucket", "stacking", "sort_by", "field_two" ],
  icon: "noun/pin.svg"
}, SamplesView);

module.exports = SamplesView;
