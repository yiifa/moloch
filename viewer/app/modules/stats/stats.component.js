(function() {

  'use strict';


  let reqPromise;   // promise returned from $interval for recurring requests
  let initialized;  // whether the graph has been initialized

  /**
   * @class StatsController
   * @classdesc Interacts with moloch stats page
   * @example
   * '<moloch-stats></moloch-stats>'
   */
  class StatsController {

    /**
     * Initialize global variables for this controller
     * @param $scope        Angular application model object
     * @param $interval     Angular's wrapper for window.setInterval
     * @param $location     Exposes browser address bar URL (based on the window.location)
     * @param $routeParams  Retrieve the current set of route parameters
     * @param StatsService  Transacts stats with the server
     * @param UserService   Transacts users and user data with the server
     *
     * @ngInject
     */
    constructor($scope, $interval, $location, $routeParams, StatsService, UserService) {
      this.$scope         = $scope;
      this.$interval      = $interval;
      this.$location      = $location;
      this.$routeParams   = $routeParams;
      this.StatsService   = StatsService;
      this.UserService    = UserService;
    }

    /* Callback when component is mounted and ready */
    $onInit() {
      this.loading = true;

      this.currentPage = 1; // always start on first page

      this.query = {
        length    : this.$routeParams.length || 50,
        start     : 0,
        filter    : null,
        sortField : 'nodeName',
        desc      : false
      };

      this.graphType      = this.$routeParams.type || 'deltaPacketsPerSec';
      this.graphInterval  = this.$routeParams.gtime || '5';
      this.dataInterval   = this.$routeParams.interval ||'5000';
      this.graphsOpen     = true;
      this.nodeStatsOpen  = true;
      this.selectedTab    = 0; // select the first tab

      this.expandedNodeStats = {};

      this.UserService.getSettings()
        .then((response) => { this.settings = response; })
        .catch((error)   => { this.settings = { timezone:'local' }; });

      // build colors array from css variables
      let styles = window.getComputedStyle(document.body);
      let primaryLighter  = styles.getPropertyValue('--color-primary-lighter').trim();
      let primaryLight    = styles.getPropertyValue('--color-primary-light').trim();
      let primary         = styles.getPropertyValue('--color-primary').trim();
      let primaryDark     = styles.getPropertyValue('--color-primary-dark').trim();
      let secondaryLighter= styles.getPropertyValue('--color-tertiary-lighter').trim();
      let secondaryLight  = styles.getPropertyValue('--color-tertiary-light').trim();
      let secondary       = styles.getPropertyValue('--color-tertiary').trim();
      let secondaryDark   = styles.getPropertyValue('--color-tertiary-dark').trim();
      this.colors = [primaryDark, primary, primaryLight, primaryLighter,
                     secondaryLighter, secondaryLight, secondary, secondaryDark];

      this.columns = [ // node stats table columns
        { name: '', doStats: false},
        { name: 'Node', sort: 'nodeName', doStats: false },
        { name: 'Time', sort: 'currentTime', doStats: true },
        { name: 'Sessions', sort: 'monitoring', doStats: true },
        { name: 'Free Space', sort: 'freeSpaceM', doStats: true },
        { name: 'CPU', sort: 'cpu', doStats: true },
        { name: 'Memory', sort: 'memory', doStats: true },
        { name: 'Packet Q', sort: 'packetQueue', doStats: true },
        { name: 'Packet/s', sort: 'deltaPackets', field: 'deltaPacketsPerSec', doStats: true },
        { name: 'Bytes/s', sort: 'deltaBytes', field: 'deltaBytesPerSec', doStats: true },
        { name: 'Sessions/s', sort: 'deltaSessions', field: 'deltaSessionsPerSec', doStats: true },
        { name: 'Packet Drops/s', sort: 'deltaDropped', field: 'deltaDroppedPerSec', doStats: true },
        { name: 'Overload Drops/s', sort: 'deltaOverloadDropped', field: 'deltaOverloadDroppedPerSec', doStats: true },
        { name: 'ES Drops/s', sort: 'deltaESDropped', field: 'deltaESDroppedPerSec', doStats: true }
      ];

      this.loadData();

      // set a recurring server req if necessary
      if (this.dataInterval !== '0') {
        reqPromise = this.$interval(() => {
          this.loadData();
        }, parseInt(this.dataInterval));
      }

      this.$scope.$on('change:pagination', (event, args) => {
        // pagination affects length, currentPage, and start
        this.query.length = args.length;
        this.query.start  = args.start;
        this.currentPage  = args.currentPage;

        initialized = false;
        this.loadData();
      });

      // watch for the user to leave or return to the page
      // Don't load graph data if the user is not focused on the page!
      // if data is loaded in an inactive (background) tab,
      // the user will experience gaps in their cubism graph data
      // cubism uses setTimeout to delay requests
      // inactive tabs' timeouts are clamped and can fire late;
      // cubism requires little error in the timing of requests
      // for more info, view the "reasons for delays longer than specified" section of:
      // https://developer.mozilla.org/en-US/docs/Web/API/WindowTimers/setTimeout#Inactive_tabs
      if (document.addEventListener) {
        document.addEventListener('visibilitychange', this.handleVisibilityChange);
      }
    }

    /* fired when controller's containing scope is destroyed */
    $onDestroy() {
      initialized = false;

      if (reqPromise) {
        this.$interval.cancel(reqPromise);
        reqPromise = null;
      }

      this.context.on('focus', null);

      this.context.stop(); // stop cubism context from continuing to issue reqs

      $('#statsGraph').empty();

      if (document.removeEventListener) {
        document.removeEventListener('visibilitychange', this.handleVisibilityChange);
      }
    }

    /* stop the requests if the user is not looking at the stats page,
       otherwise start the requests */
    handleVisibilityChange() {
      if (!this.context) { return; }
      if (document.hidden) { this.context.stop(); }
      else if (this.graphInterval !== '0' && this.graphsOpen && this.selectedTab === 0) {
        this.context.start();
      }
    }

    /* exposed methods ----------------------------------------------------- */
    /* fired when select input is changed for data interval */
    changeDataInterval() {
      // update url param
      this.$location.search('interval', this.dataInterval);

      if (reqPromise) { // cancel the interval and reset it if necessary
        this.$interval.cancel(reqPromise);

        if (this.dataInterval === '0') { return; }

        reqPromise = this.$interval(() => {
          this.loadData();
        }, parseInt(this.dataInterval));
      }
    }

    /* fired when select input is changed for graph interval */
    changeGraphInterval() {
      // update url param
      this.$location.search('gtime', this.graphInterval);

      // reinitialize the graph with new graphInterval value
      initialized = false;
      this.loadData();
    }

    /* fired when select input is changed for graph type */
    changeGraphType() {
      this.$location.search('type', this.graphType);

      initialized = false;
      this.loadData();
    }

    /**
     * Loads data with sort parameter
     * Fired when a column is clicked
     * @param {string} name The name of the column
     */
    columnClick(name) {
      this.query.sortField = name;
      this.query.desc = !this.query.desc;
      this.loadData();
    }

    /* fired when graph section is opened/closed */
    toggleGraphSection() {
      if (!this.context) { return; }

      // if it was open, it will be closing, so stop the graph from updating
      if (this.graphsOpen) { this.context.stop(); }
      // otherwise, if the graph interval isn't none, start the graph
      else if (this.graphInterval !== '0') { this.context.start(); }
    }

    /**
     * Starts/stops loading of graphs/nodes/es data based on tab
     * Fired when a tab is selected
     * @param index
     */
    selectTab(index) {
      this.selectedTab = index;

      if (index !== 0) { // not on the nodes tab
        this.$interval.cancel(reqPromise); // cancel the node req interval
        reqPromise = null;
        // stop the graph from loading data
        if (this.context) { this.context.stop(); }
      } else if (index === 0 && initialized) {
        // on the nodes tab and the graph has already been initialized
        initialized = false; // reinitialize the graph
        this.loadData();

        if (this.dataInterval !== '0') { // set up the node req interval
          reqPromise = this.$interval(() => {
            this.loadData();
          }, parseInt(this.dataInterval));
        }
      }
    }

    /* fired when node search input is changed */
    searchForNodes() {
      // reinitalize the graph
      initialized = false;
      this.loadData();
    }

    /* loads the node stats data, computes the total and average values
     * and initializes the graph if necessary */
    loadData() {
      this.StatsService.getMolochStats(this.query)
        .then((response) => {
          this.loading  = false;
          this.stats    = response;

          this.averageValues = {};
          this.totalValues = {};
          var stats = this.stats.data;

          var columnNames = this.columns.map(function(item) {return item.field || item.sort;});
          columnNames.push('memoryP');
          columnNames.push('freeSpaceP');

          if (!stats) { return; }

          for (var i = 3; i < columnNames.length; i++) {
            var columnName = columnNames[i];

            this.totalValues[columnName] = 0;
            for (var s = 0; s < stats.length; s++) {
              this.totalValues[columnName] += stats[s][columnName];
            }
            this.averageValues[columnName] = this.totalValues[columnName]/stats.length;
          }

          if (this.stats.data && !initialized && this.graphsOpen) {
            initialized = true; // only make the graph when page loads or tab switched to 0
            if (this.graphInterval === '0') {
              this.makeStatsGraph(this.graphType, 5);
              this.context.stop();
            } else {
              this.makeStatsGraph(this.graphType, parseInt(this.graphInterval, 10));
            }
          }
        })
        .catch((error) => {
          this.loading  = false;
          this.error    = error;
        });
    }

    /**
     * Creates a cubism graph of time series data for a specific metric
     * https://github.com/square/cubism/wiki/Metric
     * @param {string} metricName the name of the metric to visualize data for
     * @param {int} interval      the data grouping and request interval
     */
    makeStatsGraph(metricName, interval) {
      var self = this;
      if (self.context) { self.context.stop(); } // Stop old context
      self.context = cubism.context()
        .step(interval * 1000)
        .size(1440);
      var context = self.context;
      var nodes = self.stats.data.map(function(item) {return item.nodeName;});

      function metric(name) {
        return context.metric(function(startV, stopV, stepV, callback) {
          self.StatsService.getDetailStats({nodeName: name,
                                            start: startV/1000,
                                            stop: stopV/1000,
                                            step: stepV/1000,
                                            interval: interval,
                                            name: metricName})
            .then((response)  => { callback(null, response); })
            .catch((error)    => { return callback(new Error('Unable to load data')); });
        }, name);
      }


      context.on('focus', function(i) {
        d3.selectAll('.value').style('right', i === null ? null : context.size() - i + 'px');
      });

      $('#statsGraph').empty();
      d3.select('#statsGraph').call(function(div) {
        var metrics = [];
        for (var i = 0, ilen = nodes.length; i < ilen; i++) {
          metrics.push(metric(nodes[i]));
        }

        if (div[0][0]) {
          div.append('div')
             .attr('class', 'axis')
             .call(context.axis().orient('top'));

          div.selectAll('.horizon')
             .data(metrics)
             .enter().append('div')
             .attr('class', 'horizon')
             .call(context.horizon().colors(self.colors));

          div.append('div')
             .attr('class', 'rule')
             .call(context.rule());
        }
      });
    }

    /**
     * Opens/closes a stat in the node stats table to display cubism graphs
     * @param {obj} stat the stat row to toggle
     */
    toggleStatDetail(stat) {
      var self = this;
      let id   = stat.id.replace(/[.:]/g, '\\$&');

      this.expandedNodeStats[id] = !this.expandedNodeStats[id];

      $(document.getElementById('statsGraph-' + id)).empty();

      if (!this.expandedNodeStats[id]) {return;}

      var dcontext = cubism.context()
         .serverDelay(0)
         .clientDelay(0)
         .step(60e3)
         .size(1440);

      function dmetric(name, mname) {
        return dcontext.metric(function(startV, stopV, stepV, callback) {
          self.StatsService.getDetailStats({nodeName: stat.id,
                                            start: startV/1000,
                                            stop: stopV/1000,
                                            step: stepV/1000,
                                            interval: 60,
                                            name: mname})
             .then((response)  => {
               callback(null, response);
             })
             .catch((error)    => { return callback(new Error('Unable to load data')); });
        }, name);
      }

      var headerNames = this.columns.map(function(item) {return item.name;});
      var dataSrcs = this.columns.map(function(item) {return item.sort;});
      var metrics = [];
      for (var i = 3; i < headerNames.length; i++) {
        if (headerNames[i].match('/s')) {
          metrics.push(dmetric(headerNames[i].replace('/s', '/m'), dataSrcs[i].replace('PerSec', '')));
        } else {
          metrics.push(dmetric(headerNames[i], dataSrcs[i]));
        }
      }

      d3.select('#statsGraph-' + id).call(function(div) {
        if (div[0][0]) {
          div.append('div')
             .attr('class', 'axis')
             .call(dcontext.axis().orient('top'));

          div.selectAll('.horizon')
             .data(metrics)
             .enter().append('div')
             .attr('class', 'horizon')
             .call(dcontext.horizon().colors(self.colors));

          div.append('div')
             .attr('class', 'rule')
             .call(dcontext.rule());
        }
      });

      dcontext.on('focus', function(i) {
        d3.selectAll('.value').style('right', i === null ? null : dcontext.size() - i + 'px');
      });
    }

  }


  StatsController.$inject = ['$scope','$interval','$location','$routeParams',
    'StatsService','UserService'];

  /**
   * Moloch Stats Directive
   * Displays node stats
   */
  angular.module('moloch')
     .component('molochStats', {
       template  : require('html!./stats.html'),
       controller: StatsController
     });

})();
