function StoryCtrl($scope, $timeout) {

	$scope.isAndroid = function() {
        return /Android/i.test(navigator.userAgent);
    }(); // closure

	var isStory = function (story) {
		if (!story || story.isDeadline || story.isNextMeeting) {
			return false;
		}

		return true;
	};

	var isStoryStatus = function (story, status) {
		if (!isStory(story)) {
			return false;
		}

		if (story.status === status) {
			return true;
		}

		return false;
	}

	$scope.isStoryNew = function (story) {
		if (!isStory(story)) {
			return false;
		}

		if (!story.status || story.status === "") {
			return true;
		}

		return false;
	};

	$scope.isStorySad = function (story) {
		return isStoryStatus(story, "sad");
	};

	$scope.isStoryAssigned = function (story) {
		return isStoryStatus(story, "assigned");
	};

	$scope.isStoryActive = function (story) {
		return isStoryStatus(story, "active");
	};

	$scope.isStoryDone = function (story) {
		return isStoryStatus(story, "done");
	};

	$scope.isStoryMine = function (story) {
		if (story.owner && $scope.getAccountName) {
			var owner = story.owner.toLowerCase();
			var member = $scope.getAccountName();
			if (member) {
				member = member.toLowerCase();
				if (owner === member) {
					return true;
				}
			}
		}
		return false;
	};

	$scope.setStoryStatus = function (story, status) {
		if (story) {
			story.status = status;			
			$scope.$emit('storyChanged', story);
		}
	};

	var statusOrder = ['sad','assigned','active','done'];
	$scope.bumpStatus = function (story) {
		if (story) {
			var index = statusOrder.indexOf(story.status);
			if (index > -1) {
				index++;
				if (index < statusOrder.length) {
					// TODO: This is defined in HomeCtrl
					$scope.setStoryStatus(story, statusOrder[index]);
				}
			}
			else {
				// Do this here so we can move from sad to 
				// assigned in one go
				if ($scope.isStoryNew(story)) {
					// TODO: This is defined in HomeCtrl
					$scope.setStoryStatus(story, 'assigned');
				};
			}
		}
	};

	$scope.select = function (story) {
		// if (isDragging) {
		// 	// Do nothing. We're dragging. See the note
		// 	// in 'drag:end' as to why.
		// 	return;
		// }

		// Do not refocus stuff if we're already on this story.
		if (!story.isSelected) {
			$scope.$emit('beforeStorySelected');
			story.isSelected = true;
			$scope.$emit('storySelected', story);
		}	
	};

	$scope.deselect = function (story, event) {
		if (story && story.isSelected) {
			story.isSelected = false;
			
			$scope.$emit('storyDeselected', story, event);

			if (event) {
				event.stopPropagation();	
			}
		}
	};

	$scope.archive = function (story) {
		$scope.$emit('storyArchived', story);
	};

	$scope.remove = function (story) {
		$scope.$emit('storyRemoved', story);
	};

	$scope.notify = function (story, event) {
		$scope.$emit('storyNotify', story, event);
	};

	$scope.save = function (story) {
		$timeout(function () {
			$scope.deselect(story);	
		});
		$scope.$emit('storySaved', story);
	};
}
StoryCtrl.$inject = ['$scope', '$timeout'];