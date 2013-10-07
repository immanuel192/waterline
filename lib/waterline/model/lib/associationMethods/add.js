
/**
 * Module dependencies
 */

var _ = require('lodash'),
    async = require('async'),
    utils = require('../../../utils/helpers'),
    hasOwnProperty = utils.object.hasOwnProperty;

/**
 * Add associations for a model.
 *
 * If an object was used a new record should be created and linked to the parent.
 * If only a primary key was used then the record should only be linked to the parent.
 *
 * Called in the model instance context.
 *
 * @param {Object} collection
 * @param {Object} proto
 * @param {Object} records
 * @param {Function} callback
 */

var Add = module.exports = function(collection, proto, records, cb) {

  this.collection = collection;
  this.proto = proto;
  this.failedTransactions = [];
  this.primaryKey = null;

  var values = proto.toObject();
  var attributes = collection.waterline.schema[collection.identity].attributes;

  this.primaryKey = this.findPrimaryKey(attributes, values);

  if(!this.primaryKey) return cb(new Error('No Primary Key set to associate the record with! ' +
      'Try setting an attribute as a primary key or include an ID property.'));

  if(!proto.toObject()[this.primaryKey]) return cb(new Error('No Primary Key set to associate the record with! ' +
      'Primary Key must have a value, it can\'t be an optional value.'));

  // Loop through each of the associations on this model and add any associations
  // that have been specified. Do this in series and limit the actual saves to 10
  // at a time so that connection pools are not exhausted.
  //
  // In the future when transactions are available this will all be done on a single
  // connection and can be re-written.

  this.createCollectionAssociations(records, cb);
};

/**
 * Find Primary Key
 *
 * @param {Object} attributes
 * @param {Object} values
 * @api private
 */

Add.prototype.findPrimaryKey = function(attributes, values) {
  var primaryKey = null;

  for(var attribute in attributes) {
    if(hasOwnProperty(attributes[attribute], 'primaryKey')) {
      primaryKey = attribute;
    }
  }

  // If no primary key check for an ID property
  if(!primaryKey && hasOwnProperty(values, 'id')) primaryKey = 'id';

  return primaryKey;
};

/**
 * Create Collection Associations
 *
 * @param {Object} records
 * @param {Function} callback
 * @api private
 */

Add.prototype.createCollectionAssociations = function(records, cb) {
  var self = this;

  async.eachSeries(Object.keys(records), function(associationKey, next) {
    self.createAssociations(associationKey, records[associationKey], next);
  },

  function(err) {
    if(err || self.failedTransactions.length > 0) {
      return cb(null, self.failedTransactions);
    }

    cb();
  });
};

/**
 * Create Records for an Association property on a collection
 *
 * @param {String} key
 * @param {Array} records
 * @param {Function} callback
 * @api private
 */

Add.prototype.createAssociations = function(key, records, cb) {
  var self = this;

  // Grab the collection the attribute references
  // this allows us to make a query on it
  var attribute = this.collection._attributes[key];
  var collectionName = attribute.collection.toLowerCase();
  var associatedCollection = this.collection.waterline.collections[collectionName];
  var schema = this.collection.waterline.schema[this.collection.identity].attributes[key];

  // Limit Adds to 10 at a time to prevent the connection pool from being exhausted
  async.eachLimit(records, 10, function(association, next) {

    // If an object was passed in it should be created.
    // This allows new records to be created through the association interface
    if(typeof association === 'object' && Object.keys(association).length > 0) {
      return self.createNewRecord(associatedCollection, schema, association, next);
    }

    // If the value is a primary key just update the association's foreign key
    // This will either create the new association through a foreign key or re-associatiate
    // with another collection.
    self.updateRecord(associatedCollection, schema, association, next);

  }, cb);
};

/**
 * Create A New Record
 *
 * @param {Object} collection
 * @param {Object} attribute
 * @param {Object} values
 * @param {Function} callback
 * @api private
 */

Add.prototype.createNewRecord = function(collection, attribute, values, cb) {
  var self = this,
      insertCollection = null;

  // Check if this is a many-to-many by looking at the junctionTable flag
  var schema = this.collection.waterline.schema[attribute.collection];
  var junctionTable = schema.junctionTable || false;

  // If this isn't a many-to-many then add the foreign key in to the values
  if(!junctionTable) values[attribute.on] = this.proto[this.primaryKey];

  collection.create(values, function(err, record) {

    if(err) {
      self.failedTransactions.push({
        type: 'insert',
        collection: insertCollection.identity,
        values: values,
        err: err.message
      });
    }

    // if no junction table then return
    if(!junctionTable) return cb();

    // if junction table but there was an error don't try and link the records
    if(err) return callback();

    // Find the insertCollection's Primary Key value
    var primaryKey = self.findPrimaryKey(collection._attributes, record.toObject());

    if(!primaryKey) {
      self.failedTransactions.push({
        type: 'insert',
        collection: collection.identity,
        values: {},
        err: new Error('No Primary Key value was found on the joined collection').message
      });
    }

    // Find the Many To Many Collection
    var joinCollection = self.collection.waterline.collections[attribute.collection];

    // The related record was created now the record in the junction table
    // needs to be created to link the two records
    self.createManyToMany(joinCollection, attribute, record.id, cb);
  });
};

/**
 * Update A Record
 *
 * @param {Object} collection
 * @param {Object} attribute
 * @param {Object} values
 * @param {Function} callback
 * @api private
 */

Add.prototype.updateRecord = function(collection, attribute, values, cb) {

  // Check if this is a many-to-many by looking at the junctionTable flag
  var schema = this.collection.waterline.schema[attribute.collection];
  var junctionTable = schema.junctionTable || false;

  // If so build out the criteria and create a new record in the junction table
  if(junctionTable) {
    var joinCollection = this.collection.waterline.collections[attribute.collection];
    return this.createManyToMany(joinCollection, attribute, values, cb);
  }

  // Grab the associated collection's primaryKey
  var attributes = this.collection.waterline.schema[collection.identity].attributes;
  var associationKey = this.findPrimaryKey(attributes, attributes);

  if(!associationKey) return cb(new Error('No Primary Key defined on the child record you ' +
    'are trying to associate the record with! Try setting an attribute as a primary key or ' +
    'include an ID property.'));

  // Build up criteria and updated values used to update the record
  var criteria = {};
  var _values = {};

  criteria[associationKey] = values;
  _values[attribute.on] = this.proto[this.primaryKey];

  collection.update(criteria, _values, function(err) {

    if(err) {
      self.failedTransactions.push({
        type: 'update',
        collection: collection.identity,
        criteria: criteria,
        values: _values,
        err: err.message
      });
    }

    cb();
  });
};

/**
 * Create A Many To Many Join Table Record
 *
 * @param {Object} collection
 * @param {Object} attribute
 * @param {Object} values
 * @param {Function} callback
 * @api private
 */

Add.prototype.createManyToMany = function(collection, attribute, pk, cb) {
  var self = this;

  // Grab the associated collection's primaryKey
  var collectionAttributes = this.collection.waterline.schema[attribute.collection.toLowerCase()];
  var associationKey = this.findAssociationKey(collectionAttributes);

  if(!associationKey) return cb(new Error('No Primary Key set on the child record you ' +
    'are trying to associate the record with! Try setting an attribute as a primary key or ' +
    'include an ID property.'));

  // Build up criteria and updated values used to create the record
  var criteria = {};
  var _values = {};

  criteria[associationKey] = pk;
  criteria[attribute.on] = this.proto[this.primaryKey];
  _values = _.clone(criteria);

  // First look up the record to ensure it doesn't exist
  collection.findOne(criteria, function(err, val) {

    if(err || val) {
      self.failedTransactions.push({
        type: 'insert',
        collection: collection.identity,
        criteria: criteria,
        values: _values,
        err: err.message
      });

      return cb();
    }

    // If it doesn't exist then we can create it
    collection.create(_values, function(err) {

      if(err) {
        self.failedTransactions.push({
          type: 'insert',
          collection: collection.identity,
          criteria: criteria,
          values: _values,
          err: err.message
        });
      }

      cb();
    });
  });
};

/**
 * Find Association Key
 *
 * @param {Object} collection
 * @return {String}
 * @api private
 */

Add.prototype.findAssociationKey = function(collection) {
  var associationKey = null;

  for(var attribute in collection.attributes) {
    var attr = collection.attributes[attribute];
    var identity = this.collection.identity;

    if(!hasOwnProperty(attr, 'references')) continue;
    var attrCollection = attr.references.toLowerCase();

    if(attrCollection !== identity) {
      associationKey = attr.columnName;
    }
  }

  return associationKey;
};